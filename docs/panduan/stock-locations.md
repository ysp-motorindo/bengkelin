# Stock locations / Lokasi stok

## English

An administrator must set up at least one active stock location before creating invoices or importing inventory. A fresh installation does not create Gudang automatically.

1. Open **Reference Data → Stock locations**. Import `references/stock-location-import.csv` or add a location with a permanent code and an editable label. The supplied example is `01 / Gudang`.
2. Mark a location **Default** to prefer it for new invoices and catalog templates. Multiple defaults are allowed: the first active default wins, ordered by label ignoring case, then code and ID. Without a default, the first active location wins. Renaming does not change its identity. Deactivating all locations blocks new invoices with setup guidance.
3. In **Inventory**, select the location before reading stock, receiving goods, adjusting quantities or setting a count. Opening balances and stock history belong to that location. Selecting another location closes the previous item panel. Inactive historical locations remain readable to administrators; new movements require an active location.
4. In the invoice header, choose **Stock locations**. One location applies to the whole invoice. Changing it refreshes line stock and preserves prices. Review the location at checkout. Finalization checks that it remains active; if it was deactivated, select an active location and review again.
5. Issued invoices freeze the location code and label for history, A4, thermal and PDF output. Renaming a location later does not rewrite documents. VOID returns stock to the original location even if inactive; the existing rule that paid invoices cannot be voided remains in force.
6. Catalog CSV files now require `stock_location` for every inventory-tracked row, including existing-item updates. Use the exact reference code, such as `01`. Keep this column, SKU and barcodes as **Text** in spreadsheets so leading zeros survive. A blank or unknown code is an error and never selects another location. Services and other nontracked items may leave the location blank.
7. Import opening balances still apply only to new tracked items. Existing-item opening balances are ignored with a warning. Export chooses one location, includes its code and `current_stock`, and leaves `opening_stock` blank so reimport cannot create another opening balance.

Upgrading existing records assigns historical invoices and stock movements to `01`, creating that location only when backfill is necessary. This is migration data, not a runtime fallback. Use the existing backup/restore controls before operational changes; safety backups remain part of CSV import.

## Bahasa Indonesia

Admin harus menyiapkan setidaknya satu lokasi stok aktif sebelum membuat faktur atau mengimpor persediaan. Instalasi baru tidak membuat Gudang secara otomatis.

1. Buka **Data Referensi → Lokasi stok**. Impor `references/stock-location-import.csv` atau tambah lokasi dengan kode permanen dan label yang dapat diubah. Contoh yang disediakan adalah `01 / Gudang`.
2. Tandai **Default** untuk memprioritaskan lokasi pada faktur baru dan templat katalog. Beberapa Default diperbolehkan: lokasi Default aktif pertama dipilih, diurutkan menurut label tanpa membedakan huruf besar/kecil, lalu kode dan ID. Jika tidak ada Default, lokasi aktif pertama dipilih. Mengubah nama tidak mengubah identitas. Menonaktifkan semua lokasi akan menghalangi faktur baru dengan petunjuk penyiapan.
3. Di **Persediaan**, pilih lokasi sebelum membaca stok, menerima barang, melakukan penyesuaian atau opname. Saldo awal dan riwayat stok berlaku untuk lokasi tersebut. Mengganti lokasi menutup panel barang sebelumnya. Admin dapat membaca lokasi historis nonaktif; mutasi baru memerlukan lokasi aktif.
4. Pilih **Lokasi stok** di header faktur. Satu lokasi berlaku untuk seluruh faktur. Menggantinya memperbarui stok baris dan mempertahankan harga. Periksa lokasi saat checkout. Finalisasi memeriksa kembali status aktif; jika sudah nonaktif, pilih lokasi aktif dan tinjau ulang.
5. Faktur terbit membekukan kode dan label lokasi untuk riwayat, A4, termal dan PDF. Penggantian nama berikutnya tidak mengubah dokumen. VOID mengembalikan stok ke lokasi asal walaupun nonaktif; aturan faktur yang sudah dibayar tidak dapat di-VOID tetap berlaku.
6. CSV katalog kini memerlukan `stock_location` pada setiap baris dengan pelacakan stok, termasuk pembaruan barang lama. Gunakan kode persis dari referensi, misalnya `01`. Atur kolom ini, SKU dan barcode sebagai **Teks** di spreadsheet agar nol di depan tidak hilang. Kode kosong atau tidak dikenal adalah kesalahan dan tidak memilih lokasi lain. Jasa dan barang tanpa pelacakan boleh mengosongkannya.
7. Saldo awal impor tetap hanya berlaku bagi barang terlacak yang baru dibuat. Saldo awal untuk barang lama diabaikan dengan peringatan. Ekspor memilih satu lokasi, mencantumkan kode dan `current_stock`, serta mengosongkan `opening_stock` agar impor ulang tidak menambah saldo awal.

Peningkatan versi mengaitkan faktur dan mutasi stok lama ke `01`, membuat lokasi itu hanya jika diperlukan untuk pengisian data historis. Ini adalah data migrasi, bukan pilihan cadangan saat aplikasi berjalan. Gunakan kontrol pencadangan/pemulihan yang tersedia sebelum perubahan operasional; impor CSV tetap membuat cadangan pengaman.
