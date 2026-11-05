import Joi from 'joi';

const selections=Joi.array().items(Joi.object({
 id:Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase().required(),
 values:Joi.array().items(Joi.string().max(120).min(1)).min(1).max(10).unique(),
 min:Joi.number().strict().min(-1e12).max(1e12),
 max:Joi.number().strict().min(-1e12).max(1e12)
}).or('values','min','max').without('values',['min','max']).custom((value,helpers)=>value.min!==undefined&&value.max!==undefined&&value.min>value.max?helpers.error('any.invalid'):value)).unique('id').max(8);

// One bounded JSON query field, never SQL identifiers or executable expressions.
export const specificationQuery=Joi.string().max(4000).allow('').default('').custom((raw,helpers)=>{
 if(!raw)return [];
 try{const {error,value}=selections.validate(JSON.parse(raw));return error?helpers.error('any.invalid'):value;}
 catch{return helpers.error('any.invalid');}
});
