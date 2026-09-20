import test from 'node:test';
import assert from 'node:assert/strict';
import {compareCapture} from '../scripts/qualify-visio.mjs';
import {createDocument,createShape} from '../dist/esm/index.js';
test('native conformance comparisons fail changed geometry and text instead of claiming certification',()=>{
 const d=createDocument();d.pages[0].id='visio-p3';d.pages[0].width=960;d.pages[0].height=576;d.pages[0].shapes=[createShape('rectangle',{id:'s',sheetId:5,text:'Test',width:192,height:96})];
 const capture={pages:[{id:3,width:10,height:6,shapes:[{id:5,text:'Test',cells:{Width:{result:2},Height:{result:1}},children:[]}]}]};
 assert.deepEqual(compareCapture(capture,d),[]);d.pages[0].shapes[0].text='Lost';d.pages[0].shapes[0].width=288;
 assert.deepEqual(compareCapture(capture,d).map(d=>d.location),['visio-p3/shape:5/text','visio-p3/shape:5/Width']);
 assert.throws(()=>compareCapture(capture,d,NaN));d.pages[0].shapes[0].sheetId=9;assert.equal(compareCapture(capture,d)[0].actual,null);
});
