import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
const db = await openDatabase();
const rollback = new Error('ROLLBACK_TEST');
try {
  await db.transaction(async tx => {
    const user = randomUUID(), shop = randomUUID(), document = randomUUID(), order = randomUUID();
    await tx.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,'test-only','owner')", [user, `${user}@test.invalid`]);
    await tx.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ($1,$2,$3,'Integration fixture','Test','active')", [shop, user, shop]);
    await tx.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,'test','test','2099-01-01')", [document, shop, Buffer.from('temporary fixture')]);
    await tx.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,created) VALUES ($1,$2,$3,'test','{}',1,1,1,200,'upi',$4)", [order, shop, document, new Date().toISOString()]);
    const rows = await tx.query("UPDATE orders SET payment='paid',status=CASE WHEN EXISTS (SELECT id FROM documents WHERE id=orders.document_id) THEN 'queued' ELSE 'payment_review' END WHERE id=$1 RETURNING *", [order]);
    assert.equal(rows[0].status, 'queued');
    await tx.query('INSERT INTO rate_limits (id,count,expires) VALUES ($1,1,$2) ON CONFLICT(id) DO UPDATE SET count=rate_limits.count+1 RETURNING count', [user, '2099-01-01']);
    const [limit] = await tx.query('INSERT INTO rate_limits (id,count,expires) VALUES ($1,1,$2) ON CONFLICT(id) DO UPDATE SET count=rate_limits.count+1 RETURNING count', [user, '2099-01-01']); assert.equal(limit.count, 2);
    await tx.query('INSERT INTO uploads (id,shop_id,token,name,size,expires) VALUES ($1,$2,\'test\',\'test.pdf\',1,\'2099-01-01\')', [user, shop]);
    await tx.query("INSERT INTO upload_chunks (upload_id,part,payload,iv,tag) VALUES ($1,0,$2,'test','test')", [user, Buffer.from('x')]);
    await tx.query('DELETE FROM uploads WHERE id=$1', [user]); assert.equal((await tx.query('SELECT * FROM upload_chunks WHERE upload_id=$1', [user])).length, 0);
    await tx.query('DELETE FROM documents WHERE id=$1', [document]); assert.equal((await tx.query('SELECT * FROM documents WHERE id=$1', [document])).length, 0);
    assert.equal((await tx.query('SELECT * FROM orders WHERE id=$1', [order])).length, 1);
    throw rollback;
  });
} catch(error) { if (error !== rollback) { console.error('Neon integration failed:', error.code || error.name); process.exitCode = 1; } else console.log('Neon transaction, tenant schema, BYTEA, conditional updates, rate limiter, cascade cleanup and receipt retention verified. All test data rolled back.'); }
finally { await db.close(); }
