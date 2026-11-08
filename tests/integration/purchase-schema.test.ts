import { expect, test } from 'vitest';
import { openDatabase } from '@/main/database/connection';
import { migrateDatabase } from '@/main/database/migrate';

test('purchase drafts preserve missing prices and posted commercial values are frozen', () => {
  const db = openDatabase(':memory:');
  try {
    migrateDatabase(db);
    db.exec(`INSERT INTO cashiers(id,username,display_name,password_hash,role,created_at,updated_at) VALUES('actor','a','A','x','ADMIN','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z');
      INSERT INTO suppliers(id,name,created_at,updated_at) VALUES('s','Supplier','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z');
      INSERT INTO purchases(id,supplier_id,bill_date,due_date,created_by,updated_by,created_at,updated_at) VALUES('p','s','2026-11-08','2026-11-08','actor','actor','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z');
      INSERT INTO purchase_items(id,purchase_id,position,type,title,unit_label,quantity) VALUES('l','p',0,'NON_STOCK_ITEM','Oil','Bottle',3);`);
    expect(db.prepare('SELECT unit_price FROM purchase_items').get()).toEqual({
      unit_price: null,
    });
    expect(() =>
      db.exec("UPDATE purchases SET status='FINALIZED' WHERE id='p'"),
    ).toThrow();
    db.exec(
      "UPDATE purchase_items SET unit_price=0,amount=0,tax_subtotal=0,vat_amount=0 WHERE id='l'",
    );
    db.exec(
      "UPDATE purchases SET status='FINALIZED', document_number='PUR-20261108-0001', amount=0,tax_subtotal=0,vat_amount=0,supplier_snapshot='{}',shop_snapshot='{}',finalized_at='2026-11-08T00:00:00.000Z' WHERE id='p'",
    );
    expect(() =>
      db.exec("UPDATE purchase_items SET unit_price=1 WHERE id='l'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE purchases SET amount=10 WHERE id='p'"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM purchases WHERE id='p'")).toThrow();
  } finally {
    db.close();
  }
});
