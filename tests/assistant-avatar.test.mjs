import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarEditor, reduceAvatarEditor, avatarOwnerKey } from '../src/assistantAvatar.ts';
const owner={kind:'assistant',assistant:{hostId:'host-a',assistantId:'asst-1'}};
const asset={assetId:'a',sha256:'b',mime:'image/png',width:512,height:512};
test('preview needs explicit apply and ignores other owners, tokens and generations',()=>{
 let s=createAvatarEditor(owner,'editor');
 s=reduceAvatarEditor(s,{type:'generate',generationId:'g',editorToken:'t'});
 const result={owner,generationId:'g',editorToken:'t',state:'preview',candidate:asset};
 assert.equal(reduceAvatarEditor(s,{type:'result',job:{...result,owner:{...owner,assistant:{...owner.assistant,hostId:'host-b'}}}}),s);
 assert.equal(reduceAvatarEditor(s,{type:'result',job:{...result,editorToken:'old'}}),s);
 s=reduceAvatarEditor(s,{type:'result',job:result}); assert.equal(s.selection,undefined);
 s=reduceAvatarEditor(s,{type:'apply'}); assert.deepEqual(s.selection,{kind:'image',generationId:'g',assetId:'a'});
});
test('regenerate/cancel reject late results and preserve explicitly selected image',()=>{
 let s=createAvatarEditor(owner,'e');
 s=reduceAvatarEditor(s,{type:'generate',generationId:'a',editorToken:'a'});
 s=reduceAvatarEditor(s,{type:'result',job:{owner,generationId:'a',editorToken:'a',state:'preview',candidate:asset}});
 s=reduceAvatarEditor(s,{type:'apply'});
 s=reduceAvatarEditor(s,{type:'generate',generationId:'b',editorToken:'b'});
 s=reduceAvatarEditor(s,{type:'cancel'});
 assert.equal(reduceAvatarEditor(s,{type:'result',job:{owner,generationId:'b',editorToken:'b',state:'preview',candidate:asset}}),s);
 assert.equal(s.selection.kind,'image');
 s=reduceAvatarEditor(s,{type:'pixel'});assert.equal(s.selection.kind,'pixel');
});
test('creation drafts and duplicate host-local ids have distinct owner keys',()=>{
 assert.notEqual(avatarOwnerKey(owner),avatarOwnerKey({...owner,assistant:{...owner.assistant,hostId:'other'}}));
 assert.notEqual(avatarOwnerKey({kind:'creation',hostId:'a',draftId:'one'}),avatarOwnerKey({kind:'creation',hostId:'a',draftId:'two'}));
});
test('paid generation and cancel require trusted UI provenance',async()=>{
 const {protectedCommands}=await import('../desktop/provenance.mjs');
 assert.equal(protectedCommands.has('personal_avatar_generate'),true);
 assert.equal(protectedCommands.has('personal_avatar_cancel'),true);
});
