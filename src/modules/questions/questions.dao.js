import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
import {vendorEligibility,visibleAnswer} from './questions.rules.js';
const iso=value=>value instanceof Date?value.toISOString():value;
const map=row=>({id:uuid(row.id),productId:uuid(row.product_id),productName:row.product_name,productSlug:row.product_slug,
 storeId:uuid(row.store_id),storeName:row.store_name,question:row.question_text,status:row.status,version:Number(row.version),createdAt:iso(row.created_at),
 pendingAnswers:Number(row.pending_answers||0),publishedAnswer:row.answer_text?{body:row.answer_text,author:row.seller_name||row.store_name,kind:row.seller_name?'VENDOR':'STORE'}:null});
const base=`product_questions q JOIN products p ON p.id=q.product_id AND p.tenant_id=q.tenant_id AND p.deleted_at IS NULL
 JOIN stores s ON s.id=q.store_id AND s.tenant_id=q.tenant_id AND s.deleted_at IS NULL`;
const columns=`q.*,p.name product_name,p.slug product_slug,s.name store_name,
 (SELECT COUNT(*) FROM product_question_answers ca WHERE ca.tenant_id=q.tenant_id AND ca.question_id=q.id AND ca.status='PENDING') pending_answers`;
const pageResult=(rows,total,filters)=>({items:rows,total:Number(total),page:filters.page,pageSize:filters.pageSize,totalPages:Math.max(1,Math.ceil(Number(total)/filters.pageSize))});
export async function find({tenantId,questionId,merchantId,connection=getPrimaryPool(),lock=false}){
 const [[row]]=await connection.execute(`SELECT ${columns} FROM ${base} WHERE q.tenant_id=? AND q.id=? ${merchantId?`AND q.status='APPROVED' AND ${vendorEligibility()}`:''} ${lock?'FOR UPDATE':''}`,[id(tenantId),id(questionId),...(merchantId?[id(merchantId)]:[])]);
 return row?{...map(row),customerId:uuid(row.customer_id),moderationNote:row.moderation_note}:null;
}
export async function list({tenantId,merchantId,filters,connection=getPrimaryPool()}){
 const where=['q.tenant_id=?'],params=[id(tenantId)];
 if(merchantId){where.push(`q.status='APPROVED' AND ${vendorEligibility()}`);params.push(id(merchantId));}
 if(filters.search){where.push('(LOCATE(?,q.question_text)>0 OR LOCATE(?,p.name)>0)');params.push(filters.search,filters.search);}
 if(filters.view==='REVIEW')where.push("(q.status='PENDING' OR (q.status<>'WITHDRAWN' AND EXISTS(SELECT 1 FROM product_question_answers a WHERE a.question_id=q.id AND a.tenant_id=q.tenant_id AND a.status='PENDING'))) ");
 if(filters.view==='OPEN')where.push(`q.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM product_question_answers a WHERE a.question_id=q.id AND a.tenant_id=q.tenant_id AND ${visibleAnswer})`);
 if(filters.view==='ANSWERED')where.push(`q.status='APPROVED' AND EXISTS(SELECT 1 FROM product_question_answers a WHERE a.question_id=q.id AND a.tenant_id=q.tenant_id AND ${visibleAnswer})`);
 const sql=where.join(' AND ');
 const [[rows],[[count]]]=await Promise.all([connection.query(`SELECT ${columns} FROM ${base} WHERE ${sql} ORDER BY q.created_at DESC,q.id DESC LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),connection.execute(`SELECT COUNT(*) total FROM ${base} WHERE ${sql}`,params)]);
 return pageResult(rows.map(row=>{const value=map(row);if(merchantId)delete value.pendingAnswers;return value;}),count.total,filters);
}
export async function answers({tenantId,questionId,merchantId,filters,connection=getPrimaryPool()}){
 const where=`a.tenant_id=? AND a.question_id=? ${merchantId?"AND (a.merchant_id=? OR a.status='PUBLISHED')":''}`,params=[id(tenantId),id(questionId),...(merchantId?[id(merchantId)]:[])];
 const [[rows],[[count]]]=await Promise.all([connection.query(`SELECT a.id,a.answer_text,a.status,a.merchant_id,a.created_at,a.moderation_note,m.display_name seller_name FROM product_question_answers a LEFT JOIN merchants m ON m.id=a.merchant_id AND m.tenant_id=a.tenant_id WHERE ${where} ORDER BY (a.status='PENDING') DESC,a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),connection.execute(`SELECT COUNT(*) total FROM product_question_answers a WHERE ${where}`,params)]);
 return pageResult(rows.map(row=>({id:uuid(row.id),body:row.answer_text,status:row.status,merchantId:uuid(row.merchant_id),author:row.seller_name||'Store team',createdAt:iso(row.created_at),...(!merchantId?{moderationNote:row.moderation_note}:{})})),count.total,filters);
}
export async function answer({tenantId,questionId,answerId,connection}){const [[row]]=await connection.execute('SELECT id,merchant_id,status FROM product_question_answers WHERE tenant_id=? AND question_id=? AND id=?',[id(tenantId),id(questionId),id(answerId)]);return row?{id:uuid(row.id),merchantId:uuid(row.merchant_id),status:row.status}:null;}
export async function insertQuestion({tenantId,storeId,productId,customerId,questionId,question,hash,connection}){await connection.execute('INSERT INTO product_questions(id,tenant_id,store_id,product_id,customer_id,question_text,body_hash) VALUES(?,?,?,?,?,?,?)',[id(questionId),id(tenantId),id(storeId),id(productId),id(customerId),question,hash]);}
export async function duplicate({tenantId,storeId,productId,customerId,hash,connection}){const [[row]]=await connection.execute('SELECT id,status FROM product_questions WHERE tenant_id=? AND store_id=? AND product_id=? AND customer_id=? AND body_hash=?',[id(tenantId),id(storeId),id(productId),id(customerId),hash]);return row?{id:uuid(row.id),status:row.status}:null;}
export async function dailyCount({tenantId,customerId,connection}){const [[row]]=await connection.execute('SELECT COUNT(*) n FROM product_questions WHERE tenant_id=? AND customer_id=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY)',[id(tenantId),id(customerId)]);return Number(row.n);}
export async function insertAnswer({tenantId,questionId,answerId,merchantId,actorUserId,body,connection}){await connection.execute('INSERT INTO product_question_answers(id,tenant_id,question_id,merchant_id,created_by,answer_text) VALUES(?,?,?,?,?,?)',[id(answerId),id(tenantId),id(questionId),merchantId?id(merchantId):null,id(actorUserId),body]);await touch({tenantId,questionId,connection});}
export async function pendingOwn({tenantId,questionId,merchantId,actorUserId,connection}){const [[row]]=await connection.execute(`SELECT id FROM product_question_answers WHERE tenant_id=? AND question_id=? AND status='PENDING' AND ${merchantId?'merchant_id=?':'merchant_id IS NULL AND created_by=?'} LIMIT 1`,[id(tenantId),id(questionId),id(merchantId||actorUserId)]);return Boolean(row);}
export async function touch({tenantId,questionId,connection}){await connection.execute('UPDATE product_questions SET version=version+1 WHERE tenant_id=? AND id=?',[id(tenantId),id(questionId)]);}
export async function moderateQuestion({tenantId,questionId,status,note,actorUserId,connection}){await connection.execute('UPDATE product_questions SET status=?,moderation_note=?,moderated_by=?,version=version+1 WHERE tenant_id=? AND id=?',[status,note,actorUserId?id(actorUserId):null,id(tenantId),id(questionId)]);}
export async function moderateAnswer({tenantId,questionId,answerId,status,note,actorUserId,connection}){
 if(status==='PUBLISHED')await connection.execute("UPDATE product_question_answers SET status='REPLACED' WHERE tenant_id=? AND question_id=? AND status='PUBLISHED'",[id(tenantId),id(questionId)]);
 await connection.execute('UPDATE product_question_answers SET status=?,moderation_note=?,moderated_by=? WHERE tenant_id=? AND question_id=? AND id=?',[status,note,id(actorUserId),id(tenantId),id(questionId),id(answerId)]);
 await touch({tenantId,questionId,connection});
}
export async function publicList({tenantId,storeId,productId,filters,connection=getPrimaryPool()}){
 const predicate=`q.tenant_id=? AND q.store_id=? AND q.product_id=? AND q.status='APPROVED' AND ${visibleAnswer}`;
 const params=[id(tenantId),id(storeId),id(productId)],joins=`product_questions q JOIN product_question_answers a ON a.question_id=q.id AND a.tenant_id=q.tenant_id LEFT JOIN merchants m ON m.id=a.merchant_id AND m.tenant_id=a.tenant_id`;
 const [[rows],[[count]]]=await Promise.all([connection.query(`SELECT q.id,q.question_text,a.answer_text,a.merchant_id,m.display_name seller_name,a.updated_at FROM ${joins} WHERE ${predicate} ORDER BY a.updated_at DESC,q.id DESC LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),connection.execute(`SELECT COUNT(*) total FROM ${joins} WHERE ${predicate}`,params)]);
 return pageResult(rows.map(row=>({id:uuid(row.id),question:row.question_text,answer:row.answer_text,kind:row.merchant_id?'VENDOR':'STORE',seller:row.seller_name||null,answeredAt:iso(row.updated_at)})),count.total,filters);
}
export async function mine({tenantId,storeId,customerId,filters,connection}){
 const predicate=`q.tenant_id=? AND q.store_id=? AND q.customer_id=? ${filters.questionId?'AND q.id=?':''}`,params=[id(tenantId),id(storeId),id(customerId),...(filters.questionId?[id(filters.questionId)]:[])];
 const joins=`${base} LEFT JOIN product_question_answers a ON a.question_id=q.id AND a.tenant_id=q.tenant_id AND q.status='APPROVED' AND ${visibleAnswer} LEFT JOIN merchants m ON m.id=a.merchant_id AND m.tenant_id=a.tenant_id`;
 const [[rows],[[count]]]=await Promise.all([connection.query(`SELECT ${columns},a.answer_text,m.display_name seller_name FROM ${joins} WHERE ${predicate} ORDER BY q.created_at DESC,q.id DESC LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),connection.execute(`SELECT COUNT(*) total FROM ${base} WHERE ${predicate}`,params)]);
 return pageResult(rows.map(row=>{const value=map(row);delete value.pendingAnswers;return value;}),count.total,filters);
}
export async function vendorIds({tenantId,questionId,connection}){const [rows]=await connection.execute(`SELECT DISTINCT candidate.merchant_id FROM product_questions q JOIN seller_offers candidate ON candidate.tenant_id=q.tenant_id AND candidate.store_id=q.store_id WHERE q.tenant_id=? AND q.id=? AND ${vendorEligibility('candidate.merchant_id')}`,[id(tenantId),id(questionId)]);return rows.map(row=>uuid(row.merchant_id));}
export async function store({tenantId,storeId,connection}){const [[row]]=await connection.execute("SELECT s.base_currency FROM stores s JOIN tenants t ON t.id=s.tenant_id AND t.status='ACTIVE' AND t.deleted_at IS NULL WHERE s.tenant_id=? AND s.id=? AND s.status='ACTIVE' AND s.deleted_at IS NULL",[id(tenantId),id(storeId)]);return row?{tenantId,storeId,currency:row.base_currency}:null;}
export async function eligibleVendor({tenantId,questionId,merchantId,connection}){const [[row]]=await connection.execute(`SELECT q.id FROM product_questions q WHERE q.tenant_id=? AND q.id=? AND ${vendorEligibility()}`,[id(tenantId),id(questionId),id(merchantId)]);return Boolean(row);}
