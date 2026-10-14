// Small browser-native OOXML writer. Text is always inlineStr, never a formula.
const enc = new TextEncoder();
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function columnName(index) {
  let label='';
  for(let n=index+1;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;
  return label;
}
function sheetNames(sheets) {
  const used=new Set();
  return sheets.map((sheet,index)=>{
    const base=(String(sheet.name||`Sheet ${index+1}`).replace(/[\[\]:*?\/\\]/g,' ').replace(/^'+|'+$/g,'').trim()||`Sheet ${index+1}`).slice(0,31);
    let name=base,n=2;
    while(used.has(name.toLowerCase())){const suffix=` (${n++})`;name=base.slice(0,31-suffix.length)+suffix;}
    used.add(name.toLowerCase());return name;
  });
}

// Public style IDs: 0 body, 1 table header, 2 section, 3 note, 4 title, 5 warning.
const styles=declaration+`<styleSheet xmlns="${ns}"><fonts count="5"><font><sz val="10"/><color rgb="FF303438"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1F4C7D"/><name val="Calibri"/></font><font><sz val="9"/><color rgb="FF5E6265"/><name val="Calibri"/></font><font><b/><sz val="18"/><color rgb="FF1F4C7D"/><name val="Calibri"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4C7D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7F4E7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0D1"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="hair"><color rgb="FFD5D8DB"/></left><right style="hair"><color rgb="FFD5D8DB"/></right><top style="hair"><color rgb="FFD5D8DB"/></top><bottom style="hair"><color rgb="FFD5D8DB"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6">${[[0,0,1],[1,2,1],[2,3,1],[3,0,1],[4,0,0],[0,4,1]].map(([font,fill,border])=>`<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function worksheet(sheet,name) {
  if(!Array.isArray(sheet.rows))throw new Error(`Sheet ${name} needs an array of rows.`);
  if(sheet.rows.length>1048576)throw new Error(`Sheet ${name} exceeds Excel's row limit.`);
  const width=sheet.rows.reduce((maximum,row)=>Math.max(maximum,Array.isArray(row)?row.length:0),1);
  if(width>16384)throw new Error(`Sheet ${name} exceeds Excel's column limit.`);
  const bottom=Math.max(1,sheet.rows.length),last=`${columnName(width-1)}${bottom}`;
  const frozen=Number.isInteger(sheet.frozenRows)?Math.max(0,Math.min(sheet.frozenRows,bottom)):1;
  const body=sheet.rows.map((row,r)=>{
    if(!Array.isArray(row))throw new Error(`Sheet ${name}, row ${r+1} is not an array.`);
    const h=sheet.rowHeights?.[r],height=Number.isFinite(h)&&h>0?` ht="${Math.min(409,h)}" customHeight="1"`:'';
    return `<row r="${r+1}"${height}>${row.map((value,c)=>{
      const ref=columnName(c)+(r+1),chosen=sheet.cellStyles?.[ref]??(r===0?1:0),style=Number.isInteger(chosen)&&chosen>=0&&chosen<=5?chosen:0;
      if(typeof value==='number'&&Number.isFinite(value))return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
      if(typeof value==='boolean')return `<c r="${ref}" s="${style}" t="b"><v>${value?1:0}</v></c>`;
      const text=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
      if(text.length>32767)throw new Error(`Sheet ${name}, cell ${ref} exceeds Excel's 32,767-character cell limit. Export JSON to preserve the full value.`);
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
    }).join('')}</row>`;
  }).join('');
  const merges=sheet.merges??[];
  if(merges.some(range=>!/^\$?[A-Z]{1,3}\$?[1-9]\d*:\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(range)))throw new Error(`Invalid merged cell range in ${name}.`);
  const columns=Array.from({length:width},(_,i)=>{const w=sheet.widths?.[i];return `<col min="${i+1}" max="${i+1}" width="${Number.isFinite(w)&&w>0?Math.min(w,255):18}" customWidth="1"/>`;}).join('');
  return declaration+`<worksheet xmlns="${ns}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">${frozen?`<pane ySplit="${frozen}" topLeftCell="A${frozen+1}" activePane="bottomLeft" state="frozen"/>`:''}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${body}</sheetData>${sheet.autoFilter===false?'':`<autoFilter ref="A1:${last}"/>`}${merges.length?`<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`:''}<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;L${xml(name)}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
}

const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
function header(length){const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};}
function zipStored(files){
  const chunks=[],directory=[];let offset=0,size=0;
  for(const [path,text] of files){
    const name=enc.encode(path),data=enc.encode(text),crc=crc32(data),local=header(30),central=header(46);
    if(data.length>0xffffffff||offset>0xffffffff)throw new Error('Export exceeds the ZIP32 size limit. Use smaller date ranges.');
    const l=local.view;l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);l.setUint32(14,crc,true);l.setUint32(18,data.length,true);l.setUint32(22,data.length,true);l.setUint16(26,name.length,true);
    chunks.push(local.bytes,name,data);
    const c=central.view;c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);
    directory.push(central.bytes,name);size+=46+name.length;offset+=30+name.length+data.length;
  }
  const end=header(22),e=end.view;e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
  return new Blob([...chunks,...directory,end.bytes],{type:XLSX_MIME});
}

/** Creates a real .xlsx, with no network request or spreadsheet library. No source value becomes a formula. */
export function createWorkbookXlsx({sheets,title='Braintime Mouse Data',capturedAt=new Date().toISOString()}={}) {
  if(!Array.isArray(sheets)||!sheets.length)throw new Error('Choose at least one sheet to export.');
  if(sheets.length>1000)throw new Error('Export supports up to 1,000 sheets per workbook.');
  const names=sheetNames(sheets),date=new Date(capturedAt);
  if(Number.isNaN(date.getTime()))throw new Error('Export capture time is invalid.');
  const files=[
    ['[Content_Types].xml',declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels',declaration+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'],
    ['xl/workbook.xml',declaration+`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name,i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml',styles],
    ['docProps/core.xml',declaration+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Braintime Mouse Data</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date.toISOString()}</dcterms:created></cp:coreProperties>`],
    ['docProps/app.xml',declaration+'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Braintime Mouse Data</Application></Properties>'],
    ...sheets.map((sheet,i)=>[`xl/worksheets/sheet${i+1}.xml`,worksheet(sheet,names[i])])
  ];
  return zipStored(files);
}
