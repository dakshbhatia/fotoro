import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LocalViewer} from '../src/local/LocalViewer';
import {LocalResources,type LocalPhoto} from '../src/local/resources';
import {mergeSelectedPhotos,selectedOriginals} from '../src/local/LocalTrial';
const photo=(id:string):LocalPhoto=>({id,digest:id,filename:'same.png',date:'2026-10-01',dateSource:'selected',width:100,height:100,labels:['Ronald']});
test('retained preview viewer gates original download until a live original is reselected',()=>{
 const markup=renderToStaticMarkup(createElement(LocalViewer,{photos:[photo('a')],initial:'a',resources:new LocalResources(),onClose:()=>{}}));
 assert.match(markup,/disabled=""[^>]*>Download/);assert.match(markup,/Reselect the original/);
});
test('digest-based reselection reconnects labels without trusting an equal filename',()=>{
 const original=new File(['matching original'],'same.png');
 const merged=mergeSelectedPhotos([photo('digest-a')],[{...photo('digest-a'),file:original,labels:[]},{...photo('digest-b'),file:new File(['different original'],'same.png'),labels:[]}]);
 assert.equal(merged.length,2);assert.equal(merged.find(p=>p.id==='digest-a')?.file,original);
 assert.deepEqual(merged.find(p=>p.id==='digest-a')?.labels,['Ronald']);assert.deepEqual(merged.find(p=>p.id==='digest-b')?.labels,[]);
});
test('account selection callback includes only actual selected originals, never retained previews',()=>{
 const original=new File(['unchanged original'],'same.png');
 assert.deepEqual(selectedOriginals([photo('retained'),{...photo('live'),file:original}]),[original]);
});

test('explicit navigation reaches all three hits and keeps a pinned default browsable',async()=>{
 const {PhotoSearchIndex,emptyFeedback}=await import('../src/local/search');
 const {displaySearchResult}=await import('../src/local/LocalTrial');
 const feedback=emptyFeedback();feedback.pins[JSON.stringify(['local:all','label:ronald'])]='a';
 const index=new PhotoSearchIndex([photo('a'),photo('b'),photo('c')],feedback);
 const predicted=index.search('Ronald');assert.equal(predicted.photoId,'a');
 const b=displaySearchResult(predicted,{query:'Ronald',scope:'local:all',meaningID:'label:ronald',photoID:'b'});
 assert.deepEqual(b.photoIds,['a','b','c']);assert.equal(b.photoId,'b');
 const c=displaySearchResult(predicted,{query:'Ronald',scope:'local:all',meaningID:'label:ronald',photoID:b.photoIds[b.photoIds.indexOf(b.photoId!)+1]});
 assert.equal(c.photoId,'c');assert.equal(c.photoIds[c.photoIds.indexOf(c.photoId!)-1],'b');
 const revoked=new PhotoSearchIndex([photo('a')],feedback).search('Ronald');
 assert.equal(displaySearchResult(revoked,{query:'Ronald',scope:'local:all',meaningID:'label:ronald',photoID:'b'}).photoId,'a');
});
test('matching original reselection resets failed preview availability while preserving supplied labels',()=>{
 const original=new File(['same digest'],'same.png');
 const [merged]=mergeSelectedPhotos([{...photo('a'),previewAvailable:false,previewLoader:async()=>{throw new Error('corrupt preview')}}],[{...photo('a'),file:original,labels:[]}]);
 assert.equal(merged.previewAvailable,undefined);assert.equal(merged.previewLoader,undefined);assert.deepEqual(merged.labels,['Ronald']);
});
