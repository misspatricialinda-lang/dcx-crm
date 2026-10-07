import test from 'node:test';import assert from 'node:assert/strict';import {validateEmailClassification} from '../server/email-classification.js';
test('classification output rejects invalid categories, malformed JSON, string confidence and hidden instructions',()=>{
 for(const value of ['not json',{purpose:'spam'},{purpose:'meeting',relationship:'lead',purpose_confidence:'1',relationship_confidence:1,needs_review:false,reason:'x'}])assert.equal(validateEmailClassification(value).needs_review,true);
 const valid={purpose:'meeting',relationship:'lead',purpose_confidence:.9,relationship_confidence:.9,needs_review:false,reason:'Availability request',recipient:'attacker@example.com'};
 assert.deepEqual(validateEmailClassification(JSON.stringify(valid)),{purpose:'meeting',relationship:'lead',purpose_confidence:.9,relationship_confidence:.9,purpose_needs_review:false,relationship_needs_review:false,needs_review:false,reason:'Availability request'});
});
