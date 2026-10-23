import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
const local = await openDatabase({ url: null });
let remote;
try {
  const shops = await local.query("SELECT s.*,u.email,u.password FROM shops s JOIN users u ON u.id=s.owner_id WHERE s.owner_id NOT IN ('owner-demo','admin-demo') AND u.email NOT LIKE '%@test.invalid'");
  const inspection = [];
  for (const shop of shops) {
    const [orders] = await local.query('SELECT COUNT(*) AS count FROM orders WHERE shop_id=$1', [shop.id]);
    const [documents] = await local.query('SELECT COUNT(*) AS count FROM documents WHERE shop_id=$1', [shop.id]);
    inspection.push({ shop, orders: Number(orders.count), documents: Number(documents.count) });
  }
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify(inspection.map(({ shop, orders, documents }) => ({ name: shop.name, status: shop.status, orders, documents })))); }
  else {
    if (!process.env.DATABASE_URL) throw new Error('Neon DATABASE_URL required.');
    if (inspection.some(item => item.orders || item.documents)) throw new Error('Local shop has print records. Full encrypted-payload migration must be planned; nothing copied.');
    remote = await openDatabase();
    let copied = 0;
    await remote.transaction(async tx => {
      for (const { shop } of inspection) {
        const [existing] = await tx.query('SELECT id,role FROM users WHERE email=$1', [shop.email]);
        if (existing && existing.role !== 'owner') throw new Error('Existing remote role differs; nothing changed.');
        const ownerId = existing?.id || shop.owner_id;
        if (!existing) await tx.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'owner')", [ownerId, shop.email, shop.password]);
        const [saved] = await tx.query('SELECT id FROM shops WHERE owner_id=$1', [ownerId]);
        if (saved) continue;
        await tx.query("INSERT INTO shops (id,owner_id,slug,name,location,status,bw,color,version) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)", [shop.id, ownerId, shop.slug, shop.name, shop.location, shop.bw, shop.color, shop.version]);
        const [upi] = await local.query('SELECT upi_id,payee FROM shop_payments WHERE shop_id=$1', [shop.id]);
        if (upi) await tx.query('INSERT INTO shop_payments (shop_id,upi_id,payee) VALUES ($1,$2,$3)', [shop.id, upi.upi_id, upi.payee]);
        await tx.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), 'operator', 'shop.imported_pending', shop.id, new Date().toISOString()]);
        copied++;
      }
    });
    console.log(`${copied} existing local shop registration(s) preserved in Neon with owner password hashes and prices. Admin approval and new device pairing are required. Local data was not changed.`);
  }
} catch (error) { console.error('Local shop migration failed:', error.code || error.message); process.exitCode = 1; }
finally { await local.close(); await remote?.close(); }
