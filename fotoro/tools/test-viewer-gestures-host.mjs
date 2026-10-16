import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'fotoro-viewer-gestures-'));
try {
  const source=readFileSync('apps/ios/Fotoro/Library/RecentPhotosStore.swift','utf8');
  const start=source.indexOf('struct PhotoViewerZoom {'),end=source.indexOf('struct PhotoPreviewProgress {',start);
  if(start<0||end<0)throw new Error('Production zoom declaration boundary changed');
  writeFileSync(join(root,'Zoom.swift'),'import Foundation\nimport CoreGraphics\n'+source.slice(start,end));
  const binary=join(root,'tests');
  const compiled=spawnSync('xcrun',['swiftc','-swift-version','6',join(root,'Zoom.swift'),resolve('apps/ios/Fotoro/Library/PhotoViewerGesturePolicy.swift'),resolve('tools/fixtures/viewer-gestures-host.swift'),'-o',binary],{stdio:'inherit',timeout:60000});
  if(compiled.status!==0)process.exitCode=compiled.status??1;
  else process.exitCode=spawnSync(binary,[],{stdio:'inherit',timeout:60000}).status??1;
} finally {rmSync(root,{recursive:true,force:true});}
