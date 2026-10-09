import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDiffFiles} from '../../src/review/diff.js';
test('captures only valid changed file hunks and detects truncated bodies',()=>{
 const diff='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n';
 assert.deepEqual(reviewDiffFiles(diff),[{path:'a.js',side:'new',ranges:[[1,2]]}]);
 assert.throws(()=>reviewDiffFiles(diff.replace('+new\n','')));
 assert.throws(()=>reviewDiffFiles(diff.replace('+++ b/a.js','+++ b/../a.js')));
});
