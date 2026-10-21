'use strict';
const {createCanvas}=require('@napi-rs/canvas');
function image(){const canvas=createCanvas(1200,300),context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,1200,300);context.fillStyle='black';context.font='48px Microsoft YaHei';context.fillText('行知助手 Windows 测试 7200',40,110);return canvas;}
function scannedPDF(){
  const jpeg=image().toBuffer('image/jpeg');
  const content=Buffer.from('q 600 0 0 150 0 0 cm /Image1 Do Q');
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 150] /Resources << /XObject << /Image1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream')])];
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let size=chunks[0].length;
  objects.forEach((object,index)=>{offsets.push(size);const b=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);chunks.push(b);size+=b.length;});
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
function orientedJpeg(){
 const canvas=createCanvas(300,1200),ctx=canvas.getContext('2d');ctx.translate(0,1200);ctx.rotate(-Math.PI/2);ctx.drawImage(image(),0,0);
 const jpeg=canvas.toBuffer('image/jpeg'),exif=Buffer.alloc(32);exif.write('Exif\0\0',0,'binary');exif.write('II',6);exif.writeUInt16LE(42,8);exif.writeUInt32LE(8,10);exif.writeUInt16LE(1,14);
 exif.writeUInt16LE(0x112,16);exif.writeUInt16LE(3,18);exif.writeUInt32LE(1,20);exif.writeUInt16LE(6,24);
 const marker=Buffer.from([255,225,0,exif.length+2]);return Buffer.concat([jpeg.subarray(0,2),marker,exif,jpeg.subarray(2)]);
}
module.exports={image,scannedPDF,orientedJpeg};
