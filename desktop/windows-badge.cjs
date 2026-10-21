'use strict';
// Small taskbar overlay generated in memory; no remote image or renderer needed.
const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function image(nativeImage,count){
  if(!count)return null;const size=32,pixels=Buffer.alloc(size*size*4);
  function dot(x,y,r,g,b){if(x<0||y<0||x>=size||y>=size)return;const i=(y*size+x)*4;pixels[i]=b;pixels[i+1]=g;pixels[i+2]=r;pixels[i+3]=255;}
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if((x-15.5)**2+(y-15.5)**2<240)dot(x,y,186,42,48);
  const text=String(Math.min(99,count)),start=(size-(text.length*8-2))/2;
  [...text].forEach((char,index)=>{for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(digits[Number(char)][row*3+col]==='1')for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)dot(start+index*8+col*2+dx,11+row*2+dy,255,255,255);});
  return nativeImage.createFromBitmap(pixels,{width:size,height:size,scaleFactor:1});
}
module.exports={image};
