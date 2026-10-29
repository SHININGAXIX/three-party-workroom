"""Fetch an explicitly referenced public document; output bounded plain text JSON."""
import contextlib
import html.parser
import importlib.util
import io
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BYTES=8*1024*1024
MAX_CHARS=60000

def validate(url,proxy=False):
    u=urllib.parse.urlsplit(url)
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password:
        raise ValueError('仅支持不含登录凭证的 HTTP/HTTPS 网址。')
    host=u.hostname.lower().rstrip('.')
    if host=='localhost' or host.endswith(('.localhost','.local','.internal')):
        raise ValueError('此内部地址不在可读取范围；工作间下载请使用原下载链接。')
    for entry in socket.getaddrinfo(host,u.port or (443 if u.scheme=='https' else 80),type=socket.SOCK_STREAM):
        ip=ipaddress.ip_address(entry[4][0])
        # A configured local proxy may use a synthetic address for public DNS.
        fake_proxy=proxy and ip.version==4 and ip in ipaddress.ip_network('198.18.0.0/15')
        if not ip.is_global and not fake_proxy:
            raise ValueError('不自动读取其他内网地址。')
    return url

class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections=7
    def __init__(self,proxy): self.proxy=proxy
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        validate(newurl,self.proxy)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

class TextHTML(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.parts=[];self.title=[];self.hidden=0;self.in_title=False
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','noscript','svg'):self.hidden+=1
        if tag=='title':self.in_title=True
        if not self.hidden and tag in ('p','div','br','h1','h2','h3','li','tr','section','article'):self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript','svg') and self.hidden:self.hidden-=1
        if tag=='title':self.in_title=False
        if not self.hidden and tag in ('p','div','li','tr','h1','h2','h3'):self.parts.append('\n')
    def handle_data(self,data):
        if self.in_title:self.title.append(data)
        if not self.hidden:self.parts.append(data)

def main(request):
    url=request['url'];proxy=request.get('proxy') or '';validate(url,bool(proxy))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':proxy,'https':proxy}) if proxy else urllib.request.ProxyHandler({}),Redirects(bool(proxy)))
    req=urllib.request.Request(url,headers={'User-Agent':'Workroom/1.1 (document reader)','Accept':'text/html,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5'})
    with opener.open(req,timeout=18) as response:
        data=response.read(MAX_BYTES+1);kind=response.headers.get_content_type();encoding=response.headers.get_content_charset() or 'utf-8';final=response.geturl()
    if len(data)>MAX_BYTES:raise ValueError('网页或文档超过8MB，请下载后作为附件上传。')
    ext=Path(urllib.parse.urlsplit(final).path).suffix.lower()
    if data.startswith(b'%PDF') or kind=='application/pdf':ext='.pdf'
    if ext in ('.pdf','.docx'):
        cache=Path(request['cacheFile']);cache.parent.mkdir(parents=True,exist_ok=True);cache.write_bytes(data)
        spec=importlib.util.spec_from_file_location('workroom_extract',Path(__file__).with_name('extract-file.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        result=module.main(['read-web',str(cache.resolve()),ext]);return {**result,'title':Path(urllib.parse.urlsplit(final).path).name or '在线文档','url':final,'bytes':len(data)}
    if kind not in ('text/html','application/xhtml+xml') and not kind.startswith('text/') and kind not in ('application/json','application/xml'):
        raise ValueError('该链接暂不能转换为文字，请下载后上传文件。')
    text=data.decode(encoding,errors='replace');title=Path(urllib.parse.urlsplit(final).path).name or urllib.parse.urlsplit(final).hostname
    if kind in ('text/html','application/xhtml+xml'):
        parser=TextHTML();parser.feed(text);text='\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip());title=''.join(parser.title).strip() or title
    partial=len(text)>MAX_CHARS;text=text[:MAX_CHARS]
    return {'status':('partial' if partial else 'ready') if text.strip() else 'unavailable','text':text,'chars':len(text),'title':title,'url':final,'bytes':len(data),'note':('仅提供前60000字符。' if partial else '已获取网页文字。')+'未执行网页脚本；登录或动态内容可能不可见。'}

if __name__=='__main__':
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        try:result=main(json.load(sys.stdin))
        except urllib.error.HTTPError as error:result={'status':'unavailable','text':'','chars':0,'note':f'网站返回HTTP {error.code}，未取得可读正文。'}
        except ValueError as error:result={'status':'unavailable','text':'','chars':0,'note':str(error)}
        except Exception:result={'status':'unavailable','text':'','chars':0,'note':'网页读取失败或超时，未取得正文；可尝试直接上传文件。'}
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    print(json.dumps(result,ensure_ascii=False))
