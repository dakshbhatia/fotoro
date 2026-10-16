import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
if(process.platform!=='darwin') throw new Error('Native index host tests require macOS.');
const read=path=>readFileSync(new URL('../apps/ios/'+path,import.meta.url),'utf8');
const between=(s,a,b)=>{const start=s.indexOf(a),end=s.indexOf(b,start+a.length);if(start<0||end<0)throw new Error('Production declaration boundary changed');return s.slice(start,end);};
const pin=JSON.parse(read('Fotoro.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved')).pins.find(p=>p.identity==='grdb.swift');
if(!pin?.state.revision)throw new Error('Existing GRDB pin missing');
let dependency=`.package(url: ${JSON.stringify(pin.location)}, revision: ${JSON.stringify(pin.state.revision)})`;
if(process.env.FOTORO_GRDB_CHECKOUT){
 const checked=spawnSync('git',['-C',process.env.FOTORO_GRDB_CHECKOUT,'rev-parse','HEAD'],{encoding:'utf8'});
 if(checked.status!==0||checked.stdout.trim()!==pin.state.revision)throw new Error('Local GRDB checkout does not match product pin');
 dependency=`.package(path: ${JSON.stringify(process.env.FOTORO_GRDB_CHECKOUT)})`;
}
const root=mkdtempSync(join(tmpdir(),'fotoro-index-host-'));
try{
 mkdirSync(join(root,'Sources/Fotoro'),{recursive:true});mkdirSync(join(root,'Tests/FotoroTests'),{recursive:true});
 writeFileSync(join(root,'Package.swift'),`// swift-tools-version: 6.0\nimport PackageDescription\nlet package=Package(name:"FotoroIndexHost",platforms:[.macOS("26.0")],dependencies:[${dependency}],targets:[.target(name:"Fotoro",dependencies:[.product(name:"GRDB",package:"GRDB.swift")]),.testTarget(name:"FotoroTests",dependencies:["Fotoro"])],swiftLanguageModes:[.v5])`);
 for(const path of ['Support/FotoroError.swift','Search/SearchIndex.swift','Search/SearchModels.swift','Search/NaturalDateQuery.swift','Library/PhotoLocations.swift','People/PhotoPeopleFacts.swift'])writeFileSync(join(root,'Sources/Fotoro',path.split('/').at(-1)),read('Fotoro/'+path));
 const capture=read('Fotoro/Library/PhotoCaptureMetadata.swift'), wire=read('Fotoro/WireModels.swift');
 const declarations=[
  between(read('Fotoro/Search/VisionTextProcessor.swift'),'struct SearchOCRResult:','struct SearchPreview:'),
  between(read('Fotoro/Library/RecentPhotosStore.swift'),'struct RecentPhotoFacts {','struct PhotoBrowseContinuation'),
  capture.slice(0,capture.indexOf('extension PhotoCaptureMetadata {')),
  capture.slice(capture.indexOf('enum PhotoCaptureFacts {')),
  'import Foundation\nimport Photos\n'+between(read('Fotoro/Library/RecentPhotosStore.swift'),'enum RecentPhotosPolicy {','@MainActor struct PhotoBrowseSource'),
  between(read('Fotoro/Library/PhotoBrowsing.swift'),'enum PhotoBrowseDateScope:','enum PhotoBrowseFilter:'),
  between(wire,'struct PhotoAnnotationsV1:','struct PhotoAnnotationsUpdateV1:'),
  between(read('Fotoro/Search/PhotoSemanticProcessor.swift'),'enum SemanticVector {','// Model files are public;'),
 ];
 writeFileSync(join(root,'Sources/Fotoro/ProductionModels.swift'),declarations.join('\n'));
 for(const name of ['SearchRetrievalHostTests.swift','SearchTests.swift','NaturalDateSearchTests.swift'])writeFileSync(join(root,'Tests/FotoroTests',name),read('FotoroTests/'+name));
 const result=spawnSync('swift',['test','--package-path',root,'--scratch-path',process.env.FOTORO_SEARCH_HOST_BUILD??join(tmpdir(),'fotoro-search-host-build')],{stdio:'inherit',timeout:300000});
 if(result.error)throw result.error;process.exitCode=result.status??1;
}finally{rmSync(root,{recursive:true,force:true});}
