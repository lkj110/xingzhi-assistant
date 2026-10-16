const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {limits} = require('./image-ocr.cjs');

function imagePayload(image) {
  if (!image || image.isEmpty()) throw Error('剪贴板中没有图片，请先截图或复制图片');
  const {width, height} = image.getSize();
  if (width > limits.edge || height > limits.edge || width * height > limits.pixels) throw Error('截图过大，请裁剪到 10000 像素边长、2500 万总像素以内');
  const bytes = image.toPNG();
  if (!bytes.length || bytes.length > limits.bytes) throw Error('截图超过 10 MB，请缩小后重试');
  return {title:`截图-${new Date().toISOString().replace(/[:.]/g,'-')}.png`,base64:bytes.toString('base64')};
}
function create({clipboard, nativeImage, platform=process.platform, run=execFile}) {
  let capturing=false;
  return async function screenshot(action, window) {
    if (action === 'screenshotClipboard') return imagePayload(clipboard.readImage());
    if (action !== 'screenshotRegion') throw Error('未知截图操作');
    if (platform !== 'darwin') throw Error('框选截图当前支持 macOS；其他系统可粘贴截图');
    if (capturing) throw Error('请先完成或取消当前截图');
    capturing=true;
    let directory, wasVisible=false;
    try {
      directory=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-screenshot-'));
      fs.chmodSync(directory,0o700);
      const file=path.join(directory,'selection.png');
      wasVisible=!!window&&!window.isDestroyed()&&window.isVisible();
      if (wasVisible) window.hide();
      const result=await new Promise(resolve=>run('/usr/sbin/screencapture',['-i','-s','-x','-t','png',file],{timeout:120000,maxBuffer:4096},error=>resolve(error)));
      if (result?.killed) throw Error('截图等待超时，请重新框选');
      if (!fs.existsSync(file)) {
        if (result) throw Error('截图未完成；可重试或在系统设置中允许行知助手录制屏幕，也可使用系统截图后粘贴');
        return {cancelled:true};
      }
      const stat=fs.lstatSync(file);
      if (!stat.isFile()||stat.isSymbolicLink()||stat.size>limits.bytes) throw Error('截图无效或超过 10 MB，请缩小范围');
      return imagePayload(nativeImage.createFromBuffer(fs.readFileSync(file)));
    } finally {
      if (directory) fs.rmSync(directory,{recursive:true,force:true});
      capturing=false;
      if (wasVisible&&!window.isDestroyed()) {window.show();window.focus();}
    }
  };
}
module.exports={create,imagePayload};
