import {createHash} from 'node:crypto';
import {createDecision} from './decisions.js';
const text={type:'string',minLength:1,maxLength:4096};
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export const productQuestionSchema=object({id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},title:{...text,maxLength:160},options:{type:'array',minItems:2,maxItems:8,items:object({id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},description:{...text,maxLength:1000}})},choice:{type:'string'},rationale:text});
export function validateProductQuestion(question) {
 const record=createDecision({...question,tier:2},{runId:'question-validation',requestDigest:'a'.repeat(64),planDigest:'b'.repeat(64),actor:{kind:'agent',id:'worker'},now:'2026-01-01T00:00:00.000Z'});
 return {id:record.id,title:record.title,options:record.options,choice:record.choice,rationale:record.rationale};
}

export function scopedProductQuestion(question,sourceId) {
 const value=validateProductQuestion(question);
 return {...value,id:`question-${createHash('sha256').update(`${sourceId}:${value.id}`).digest('hex').slice(0,40)}`};
}
