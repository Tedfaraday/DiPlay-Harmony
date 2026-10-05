from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from lxml import etree
import json
root=Path(__file__).resolve().parent/'build';plan=json.loads((root/'animation-plan.json').read_text(encoding='utf-8'))
ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
with ZipFile(root/'design.pptx')as src,ZipFile(root/'design-named.pptx','w',ZIP_DEFLATED)as out:
 for entry in src.infolist():
  data=src.read(entry.filename)
  for page in plan:
   if entry.filename==f"ppt/slides/slide{page['slide']}.xml":
    xml=etree.fromstring(data);pics=xml.findall('.//p:pic/p:nvPicPr/p:cNvPr',ns);imgs=[i for i in page['effects']if i['image']]
    assert len(pics)==len(imgs),(page['slide'],len(pics),len(imgs))
    for pic,item in zip(pics,imgs):pic.set('name',item['key']);pic.set('descr',item['key'])
    data=etree.tostring(xml,xml_declaration=True,encoding='UTF-8',standalone=True)
  out.writestr(entry,data)
print('Animation picture names persisted')
