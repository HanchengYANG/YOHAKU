#!/usr/bin/env python3
"""Local, bounded PDF/EPUB parsing. No network or AI calls occur here."""
import argparse
from contextlib import closing
import html
import json
from pathlib import Path
import posixpath
import re
import sys
from urllib.parse import unquote
import xml.etree.ElementTree as ET
from zipfile import ZipFile

MAX_XML = 20 * 1024 * 1024
MAX_TEXT = 5_000_000


def local_name(tag):
    return tag.rsplit('}', 1)[-1].lower() if isinstance(tag, str) else ''


def safe_xml(data):
    if len(data) > MAX_XML or b'<!ENTITY' in data.upper():
        raise ValueError('EPUB 章节过大或包含不支持的实体声明。')
    return ET.fromstring(data)


def base_text(element):
    if local_name(element.tag) in ('rt', 'rp', 'script', 'style', 'nav'):
        return ''
    if local_name(element.tag) == 'br':
        return '\n'
    return (element.text or '') + ''.join(base_text(child) + (child.tail or '') for child in element)


def inline_html(element):
    tag = local_name(element.tag)
    if tag in ('script', 'style', 'nav', 'img', 'iframe', 'object', 'svg'):
        return ''
    if tag == 'ruby':
        return ruby_html(element)
    inside = html.escape(element.text or '') + ''.join(inline_html(child) + html.escape(child.tail or '') for child in element)
    if tag in ('rt', 'rp'):
        return f'<{tag}>{inside}</{tag}>'
    if tag == 'br':
        return '<br>'
    return inside


def ruby_html(element):
    # EPUB permits repeated implicit base/rt pairs and separate rb/rt lists.
    # Canonical article HTML uses one reading per ruby, so retain each pair.
    bases, readings = [], []
    pending = html.escape(element.text or '')
    for child in element:
        tag = local_name(child.tag)
        if tag in ('rt', 'rb'):
            if pending:
                bases.append(pending)
                pending = ''
            if tag == 'rt':
                readings.append(''.join(child.itertext()))
            else:
                bases.append(inline_html(child))
        elif tag != 'rp':
            pending += inline_html(child)
        pending += html.escape(child.tail or '')
    if pending:
        bases.append(pending)
    if not readings:
        return ''.join(bases)
    if len(bases) != len(readings):
        bases, readings = [''.join(bases)], [''.join(readings)]
    return ''.join('<ruby data-origin="source">' + base + '<rt>' + html.escape(reading) + '</rt></ruby>'
                   for base, reading in zip(bases, readings))


def epub_info(filename):
    with ZipFile(filename) as archive:
        infos = archive.infolist()
        if len(infos) > 5000 or sum(info.file_size for info in infos) > 100 * 1024 * 1024:
            raise ValueError('EPUB 解压内容过大，请拆分后导入。')
        if archive.read('mimetype').strip() != b'application/epub+zip':
            raise ValueError('这不是有效的 EPUB 文件。')
        container = safe_xml(archive.read('META-INF/container.xml'))
        rootfiles = [node for node in container.iter() if local_name(node.tag) == 'rootfile']
        if not rootfiles:
            raise ValueError('EPUB 缺少书籍内容索引。')
        opf_path = rootfiles[0].attrib['full-path']
        package = safe_xml(archive.read(opf_path))
        root_dir = posixpath.dirname(opf_path)
        manifest = {node.attrib['id']: node.attrib for node in package.iter() if local_name(node.tag) == 'item'}
        spine = [node.attrib.get('idref') for node in package.iter() if local_name(node.tag) == 'itemref' and node.attrib.get('linear', 'yes') != 'no']
        titles = [node.text for node in package.iter() if local_name(node.tag) == 'title' and node.text]
        chapters = []
        accumulated = 0
        for chapter_index, item_id in enumerate(spine):
            item = manifest.get(item_id)
            if not item or item.get('media-type') not in ('application/xhtml+xml', 'text/html'):
                continue
            path = posixpath.normpath(posixpath.join(root_dir, unquote(item['href'].split('#')[0])))
            if path.startswith('../') or path.startswith('/'):
                raise ValueError('EPUB 包含无效的章节路径。')
            raw = archive.read(path)
            document = safe_xml(raw)
            body = next((node for node in document.iter() if local_name(node.tag) == 'body'), document)
            paragraphs = []
            paragraph_tags = ('p', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'pre')
            block_tags = paragraph_tags + ('div', 'body', 'section', 'article', 'main', 'header', 'footer', 'aside', 'ul', 'ol')
            def collect(node):
                tag = local_name(node.tag)
                if tag in ('script', 'style', 'nav'):
                    return
                if tag in paragraph_tags:
                    text = base_text(node).strip()
                    if text:
                        paragraphs.append({'text': text, 'bodyHtml': '<p>' + inline_html(node).strip() + '</p>'})
                    return
                # Containers can mix direct text, inline content and blocks.
                # Flush each inline run around blocks instead of dropping it
                # whenever another heading or paragraph has already been found.
                pending_text = node.text or ''
                pending_html = html.escape(pending_text)
                def flush():
                    nonlocal pending_text, pending_html
                    text = pending_text.strip()
                    if text:
                        paragraphs.append({'text': text, 'bodyHtml': '<p>' + pending_html.strip() + '</p>'})
                    pending_text, pending_html = '', ''
                for child in node:
                    if local_name(child.tag) in block_tags:
                        flush()
                        collect(child)
                    else:
                        pending_text += base_text(child)
                        pending_html += inline_html(child)
                    pending_text += child.tail or ''
                    pending_html += html.escape(child.tail or '')
                flush()
            collect(body)
            if not paragraphs:
                text = base_text(body).strip()
                if text:
                    paragraphs.append({'text': text, 'bodyHtml': '<p>' + html.escape(text) + '</p>'})
            headings = [base_text(node).strip() for node in body.iter() if local_name(node.tag) in ('h1','h2') and base_text(node).strip()]
            chapter_title = headings[0][:160] if headings else f'第 {len(chapters)+1} 章'
            groups = []
            current = []
            current_length = 0
            for paragraph in paragraphs:
                if current and current_length + len(paragraph['text']) + 1 > 1000:
                    groups.append({'text': '\n'.join(p['text'] for p in current), 'bodyHtml': ''.join(p['bodyHtml'] for p in current)})
                    current = []
                    current_length = 0
                current.append(paragraph)
                current_length += len(paragraph['text']) + 1
            if current:
                groups.append({'text': '\n'.join(p['text'] for p in current), 'bodyHtml': ''.join(p['bodyHtml'] for p in current)})
            # Sources join continuously. The original separator between complete
            # paragraph groups therefore belongs to the preceding group.
            for group in groups[:-1]:
                group['text'] += '\n'
                group['bodyHtml'] += '<p></p>'
            accumulated += sum(len(group['text']) for group in groups)
            if accumulated > MAX_TEXT:
                raise ValueError('EPUB 正文过大，请按卷拆分导入。')
            chapters.append({'id': f'epub-{chapter_index+1}', 'title': chapter_title, 'path': path,
                             'bodyHtml': ''.join(paragraph['bodyHtml'] for paragraph in paragraphs), 'groups': groups})
        if not chapters:
            raise ValueError('EPUB 没有可读取的正文章节。')
        return {'detectedType': 'epub', 'title': (titles[0] if titles else Path(filename).stem)[:160], 'chapters': chapters}


def pdf_open(filename):
    try:
        import pypdfium2
    except ImportError as error:
        raise RuntimeError('PDF 解析环境不可用，请运行 scripts/install-document-runtime.sh。') from error
    return pypdfium2.PdfDocument(filename)


def pdf_page(document, number):
    if not isinstance(number, int) or number < 1 or number > len(document):
        raise ValueError('PDF 实际页码超出原文件范围。')
    return document[number - 1]


def extract_pdf_text(document, number):
    with closing(pdf_page(document, number)) as page:
        with closing(page.get_textpage()) as textpage:
            return textpage.get_text_range().replace('\r\n', '\n').replace('\r', '\n')


def pdf_inspect(filename):
    with closing(pdf_open(filename)) as document:
        count = len(document)
        if count < 1 or count > 50000:
            raise ValueError('PDF 页数无效或过大。')
        toc = [{'title': item.title[:160], 'level': item.level, 'page': item.page_index + 1 if item.page_index is not None else None,
                'needsReview': item.page_index is None} for item in document.get_toc()]
        # Only a small initial sample is extracted for local classification and the chapter prompt.
        # No full-document OCR, correction, segmentation or annotation is performed.
        sampled = list(range(1, min(count, 5) + 1))
        pages = [{'page': number, 'printedLabel': document.get_page_label(number-1),
                  'text': extract_pdf_text(document, number)[:12000]} for number in sampled]
        has_text = any(len(re.sub(r'\s', '', page['text'])) >= 10 for page in pages)
        return {'detectedType': 'text_pdf' if has_text else 'scan_pdf', 'title': Path(filename).stem[:160],
                'pageCount': count, 'toc': toc, 'pages': pages}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['inspect-pdf','inspect-epub','extract-pdf','render-pdf'])
    parser.add_argument('file')
    parser.add_argument('--page', type=int)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.operation == 'inspect-pdf':
        result = pdf_inspect(args.file)
    elif args.operation == 'inspect-epub':
        result = epub_info(args.file)
    elif args.operation == 'extract-pdf':
        with closing(pdf_open(args.file)) as document:
            result = {'text': extract_pdf_text(document, args.page), 'firstExtractionLabel': 'PDF 首次提取结果'}
    else:
        if not args.output:
            raise ValueError('需要指定 PDF 页面预览输出位置。')
        with closing(pdf_open(args.file)) as document:
            with closing(pdf_page(document, args.page)) as page:
                bitmap = page.render(scale=2)
                try:
                    bitmap.to_pil().save(args.output, format='PNG')
                finally:
                    bitmap.close()
        result = {'path': args.output}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
