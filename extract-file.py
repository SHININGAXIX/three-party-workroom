"""Bounded, local text extraction for workroom attachments (no document editing).

CLI: python extract-file.py ABSOLUTE_PATH docx|pdf
Only one JSON result is emitted to stdout. Document contents are never logged.
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 20 * 1024 * 1024
MAX_ZIP_ENTRIES = 4096
MAX_CHARS = 60000
MAX_PDF_PAGES = 300
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
WORD_NS_STRICT = "{http://purl.oclc.org/ooxml/wordprocessingml/main}"
SELECTED_XML = re.compile(r"word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml\Z")


class Unavailable(Exception):
    """An expected limitation, with a safe public explanation."""


class TextBuffer:
    def __init__(self):
        self.parts = []
        self.chars = 0
        self.truncated = False

    def add(self, value: str):
        # Some PDF extractors return NUL or unpaired Unicode surrogates.
        value = value.replace("\x00", "").encode("utf-8", "replace").decode("utf-8")
        remaining = MAX_CHARS - self.chars
        if len(value) > remaining:
            self.truncated = True
            value = value[:remaining]
        self.parts.append(value)
        self.chars += len(value)

    def text(self):
        return "".join(self.parts).strip()


def result(status: str, text: str = "", note: str = ""):
    return {"status": status, "text": text, "chars": len(text), "note": note}


def finish(buffer: TextBuffer, note: str, partial_notes=None):
    extra = list(partial_notes or [])
    if buffer.truncated:
        extra.append(f"文本超过 {MAX_CHARS:,} 字符，仅提取前 {MAX_CHARS:,} 字符。")
    text = buffer.text()
    if not text:
        return result("unavailable", note="未提取到可读文字；图片或扫描内容需要另行 OCR。" + note + "".join(extra))
    return result("partial" if extra else "ready", text, note + "".join(extra))


def paragraph_nodes(paragraph):
    # Text boxes can contain paragraphs inside an outer paragraph. Each inner
    # paragraph is visited independently by root.iter(), so exclude it here.
    pending = list(reversed(list(paragraph)))
    while pending:
        node = pending.pop()
        if node.tag in (WORD_NS + "p", WORD_NS_STRICT + "p"):
            continue
        yield node
        pending.extend(reversed(list(node)))


def extract_docx(path: Path):
    buffer = TextBuffer()
    note = "已提取正文、表格单元格及存在的页眉、页脚和脚注/尾注文字；未读取图片、批注、嵌入对象或外部链接，版式和表格关系可能丢失。"
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ZIP_ENTRIES:
            raise Unavailable(f"DOCX 内文件超过 {MAX_ZIP_ENTRIES} 项，停止解析。")
        selected = [entry for entry in entries if SELECTED_XML.fullmatch(entry.filename)]
        if not any(entry.filename == "word/document.xml" for entry in selected):
            raise Unavailable("文件不是可识别的 DOCX 文档：缺少正文。")
        if len({entry.filename for entry in selected}) != len(selected):
            raise Unavailable("DOCX 包含重复的文字部件，停止解析。")
        if sum(entry.file_size for entry in selected) > MAX_XML_BYTES:
            raise Unavailable("DOCX 文字 XML 解压后超过 20 MB，停止解析。")
        if any(entry.flag_bits & 1 for entry in selected):
            raise Unavailable("DOCX 文字部件已加密，无法读取。")
        selected.sort(key=lambda entry: (entry.filename != "word/document.xml", entry.filename))
        consumed = 0
        for entry in selected:
            if buffer.truncated:
                break
            with archive.open(entry) as member:
                raw = member.read(MAX_XML_BYTES - consumed + 1)
            consumed += len(raw)
            if consumed > MAX_XML_BYTES:
                raise Unavailable("DOCX 文字 XML 解压后超过 20 MB，停止解析。")
            # Remove NULs for declaration checks so UTF-16/32 XML cannot bypass
            # the DTD/entity rejection before ElementTree decodes the document.
            declarations = raw.replace(b"\x00", b"").upper()
            if b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
                raise Unavailable("DOCX 文字 XML 含不支持的文档类型或实体声明，停止解析。")
            root = ElementTree.fromstring(raw)
            paragraphs = (node for node in root.iter() if node.tag in (WORD_NS + "p", WORD_NS_STRICT + "p"))
            for paragraph in paragraphs:
                for node in paragraph_nodes(paragraph):
                    namespace = next((ns for ns in (WORD_NS, WORD_NS_STRICT) if node.tag.startswith(ns)), None)
                    if namespace is None:
                        continue
                    tag = node.tag[len(namespace):]
                    if tag == "t" and node.text:
                        buffer.add(node.text)
                    elif tag == "tab":
                        buffer.add("\t")
                    elif tag in ("br", "cr"):
                        buffer.add("\n")
                    if buffer.truncated:
                        break
                buffer.add("\n")
                if buffer.truncated:
                    break
    return finish(buffer, note)


def pdf_backend():
    try:
        import pymupdf
        return "pymupdf", pymupdf
    except ImportError:
        pass
    try:
        import pypdf
        return "pypdf", pypdf
    except ImportError:
        raise Unavailable("本机 Python 未提供 PDF 文字解析库；原文件仍可下载。") from None


def extract_pdf(path: Path):
    kind, module = pdf_backend()
    buffer = TextBuffer()
    notes = []
    note = "已按原文件页码提取 PDF 文字；未做 OCR，图片、扫描内容和版式关系不在文字提取范围内。"
    text_pages = 0
    empty_pages = 0
    failed_pages = 0
    if kind == "pymupdf":
        document = module.open(path)
        if document.needs_pass:
            document.close()
            raise Unavailable("PDF 已加密，需要先提供可直接打开的文件。")
        pages = len(document)
        page_text = lambda index: document[index].get_text("text")
    else:
        document = module.PdfReader(str(path), strict=False)
        if document.is_encrypted:
            raise Unavailable("PDF 已加密，需要先提供可直接打开的文件。")
        pages = len(document.pages)
        page_text = lambda index: document.pages[index].extract_text() or ""
    try:
        if pages > MAX_PDF_PAGES:
            notes.append(f"原文件 {pages} 页，仅检查前 {MAX_PDF_PAGES} 页。")
        for index in range(min(pages, MAX_PDF_PAGES)):
            try:
                text = page_text(index).strip()
            except Exception:
                failed_pages += 1
                continue
            if not text:
                empty_pages += 1
                continue
            text_pages += 1
            buffer.add(f"\n\n[第 {index + 1} 页]\n")
            buffer.add(text)
            if buffer.truncated:
                break
    finally:
        close = getattr(document, "close", None)
        if close:
            close()
    if failed_pages:
        notes.append(f"有 {failed_pages} 页文字解析失败。")
    if empty_pages:
        notes.append(f"已检查的页面中 {empty_pages} 页没有可提取文字，可能为空白页或扫描页。")
    if not text_pages:
        return result("unavailable", note="未提取到可读文字；图片或扫描内容需要另行 OCR。" + "".join(notes))
    return finish(buffer, note, notes)


def main(argv):
    if len(argv) != 3:
        return result("unavailable", note="调用参数不完整；需要本机绝对路径和 docx/pdf 类型。")
    path = Path(argv[1])
    extension = argv[2].lower().lstrip(".")
    if extension not in ("docx", "pdf"):
        return result("unavailable", note="该类型暂不支持自动文字提取。")
    if not path.is_absolute() or not path.is_file():
        return result("unavailable", note="待解析文件不存在或未使用绝对路径。")
    if path.stat().st_size > MAX_FILE_BYTES:
        return result("unavailable", note="文件超过 64 MB，跳过自动文字提取；原文件仍可下载。")
    return extract_docx(path) if extension == "docx" else extract_pdf(path)


if __name__ == "__main__":
    # Libraries may warn about malformed input. Keep diagnostics out of chat and
    # return a stable public message without including private paths or text.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            output = main(sys.argv)
        except Unavailable as error:
            output = result("unavailable", note=str(error))
        except Exception:
            output = result("unavailable", note="无法解析文件：内容可能损坏、加密或采用了不支持的格式。原文件仍可下载。")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
