# Pembelian dari pemasok

Menu **Pembelian** berada tepat setelah **Penjualan**. Kasir dan admin dapat menggunakannya. Pembelian, pembayaran, dan penerimaan barang dicatat terpisah.

## Mencatat faktur pemasok

1. Buka Pembelian dan buat pembelian baru, atau lanjutkan draf tersimpan.
2. Pilih pemasok. Gunakan Tambah pemasok bila belum tersedia. Nama wajib; telepon, email, dan alamat opsional. Pemasok nonaktif tetap tersimpan untuk riwayat dan penyelesaian faktur lama.
3. Isi nomor faktur pemasok jika ada, tanggal, tempo pembayaran, dan catatan.
4. Cari/pindai barang atau tambahkan barang/jasa khusus. **Harga beli selalu kosong saat barang baru dipilih.** Isi jumlah dan harga beli; harga jual katalog tidak berubah.
5. Isi diskon bertahap dan PPN termasuk bila diperlukan. Lengkapi semua harga untuk menghitung total. Harga nol memerlukan persetujuan saat tinjauan.
6. Tambahkan pembayaran yang benar-benar sudah dilakukan, atau biarkan kosong untuk faktur belum dibayar.
7. Tinjau lalu catat faktur. Periksa nomor `PUR-...`, total, sisa utang, dan status penerimaan. Mencatat faktur tidak menambah stok.

Draf disimpan otomatis. Periksa indikator tersimpan sebelum keluar. Jika penyimpanan gagal, pertahankan isian dan gunakan Coba lagi. Jika data berubah oleh petugas lain, tinjau versi terbaru sebelum mengulangi tindakan.

## Menerima barang atau jasa

Buka faktur melalui Riwayat Pembelian atau Penerimaan, lalu catat jumlah yang benar-benar diterima. Pilih lokasi untuk setiap penerimaan. Pengiriman dapat diterima sebagian dan di lokasi berbeda. Produk dengan pelacakan persediaan menambah stok; barang nonstok/jasa hanya mencatat penerimaan.

Periksa nomor `RCV-...`, lokasi, jumlah diterima, dan sisa penerimaan. Pembayaran faktur tidak berubah. Penerimaan yang salah dapat dibatalkan seluruhnya sebelum ada kredit dari penerimaan tersebut. Pembatalan mengurangi stok dan mengembalikan jumlah menjadi belum diterima.

## Kredit, retur, pembayaran, dan pengembalian dana

- Untuk barang belum dikirim, pilih sumber **Belum diterima** pada Retur / kredit pemasok. Kredit mengurangi sisa penerimaan tanpa mengubah stok.
- Untuk retur barang yang telah diterima, pilih bukti penerimaan asal. Retur mengurangi stok di lokasi asal dan menggunakan harga bersih serta pajak faktur asal. Jumlah retur tidak menjadi pesanan pengganti.
- Kredit mengurangi faktur asal. Kredit tidak otomatis mencatat uang kembali dan tidak dipindahkan ke faktur lain.
- Bila pembayaran melebihi nilai faktur setelah kredit, periksa dana yang harus dikembalikan. Catat dana diterima **hanya setelah pemasok benar-benar mengembalikan uang**.
- Pembayaran lanjutan tidak boleh melebihi sisa utang; dana diterima tidak boleh melebihi saldo pengembalian.
- Retur atau pembatalan penerimaan yang membuat stok negatif menampilkan peringatan dan memerlukan persetujuan.

Periksa hasil di riwayat faktur, bukan hanya pesan keberhasilan. Pembayaran, kredit, dan pengembalian dana yang sudah dicatat tidak dapat diedit. Tinjau jumlah dan sumber sebelum konfirmasi. Faktur tanpa pembayaran dapat dibatalkan setelah seluruh penerimaannya dibatalkan; kredit sebelumnya tetap tercatat.

## Laporan, cetak, dan cadangan

Faktur pembelian mendukung cetak A4/termal dan PDF A4. Bukti penerimaan serta nota kredit mendukung A4/PDF. Kegagalan cetak tidak membatalkan transaksi; cetak ulang dari dokumen tersimpan.

Laporan Harian memisahkan pembelian, kredit/pembatalan, pembayaran keluar, dan dana kembali dari penjualan. Setiap aktivitas mengikuti waktu pencatatannya pada zona waktu toko. Filter kanal berlaku untuk penjualan saja; filter kasir mengikuti petugas yang melakukan aktivitas.

Cadangan menyimpan seluruh data pembelian. Pratinjau pemulihan menampilkan jumlah pemasok dan faktur pembelian. Pemulihan cadangan lama mengembalikan data sesuai isi cadangan, tetapi nomor PUR/RCV/PCN yang sudah pernah diterbitkan tidak digunakan ulang.

## Latihan penerimaan dan penyelesaian

Pada profil latihan: beli 10 unit @Rp10.000, bayar Rp60.000, terima 6 unit di A dan 2 di B, kreditkan 2 unit yang belum dikirim, lalu retur 3 unit dari A. Hasil: stok A=3/B=2, tidak ada sisa penerimaan, dana kembali Rp10.000. Setelah dana diterima dicatat, faktur lunas. Periksa ulang setelah aplikasi dibuka kembali.

Untuk validasi dengan kasir, berikan faktur dan rincian pengiriman/retur tanpa menyebut menu atau tombol. Amati apakah kasir menemukan alur, memasukkan harga, serta dapat menjelaskan sisa penerimaan dan saldo dana kembali tanpa bantuan. Pengujian otomatis tidak menggantikan pemeriksaan ini.

---

# Supplier purchases — quick guide

Open **Purchase**, immediately after Sales. Select or create a supplier, enter the supplier bill details, then select products or custom goods/services. Every new product starts with a blank purchase price. Enter quantities and prices; discounts and inclusive VAT follow sales conventions. Record actual outgoing payments or leave the bill unpaid. Review and record the bill. Finalization does not add stock or alter catalog prices.

Record deliveries separately, including partial quantities and the location of each delivery. Only tracked products add stock. Check the receipt number, location, and quantity still expected. Reverse an incorrect whole receipt before any of its quantities have been credited.

Supplier credits can cancel undelivered quantities or return quantities from a specific receipt. Returns remove stock at the original location and use the original net prices and tax. Credits stay on their original bill. Returned quantities do not reopen delivery expectations. A credit never implies that cash has been refunded: record a refund only when money is actually received.

Use purchase history to review receipts, payments, credits, refunds, and the independent settlement/receiving states. Posted payments, credits, and refunds are immutable; review entries before confirming. Failed requests preserve entries for retry. Negative-stock actions require acknowledgment.

Print bills in A4/thermal and receipts/credits in A4, or export A4 PDFs. Print failures leave the recorded transaction intact. Daily reports keep purchasing separate from sales and use each activity's posting time. Backups include purchasing, and restore protects previously issued document numbers.

Navigation: Purchase → New Purchase / Purchase History / Receiving / Payables & Refunds / Suppliers. Switching back to Purchase opens the editor and retains your draft.

Navigasi: Pembelian → Buat Pembelian / Riwayat Pembelian / Penerimaan / Utang & Pengembalian Dana / Pemasok. Kembali ke Pembelian membuka editor dan mempertahankan draf.

## Tata letak ringkas / Compact workspace

**Indonesia:** Draf tersimpan, Pembelian baru, Buang draf, dan status simpan berada di bilah atas. Pemasok dan rincian faktur berada di atas tabel barang. Catatan berada di kiri bawah; diskon, PPN, pembayaran keluar, total, dan Tinjau pembelian berada di kanan bawah. Pilih Pembayaran keluar untuk mengisi pembayaran; Tutup menyimpan perubahan sebelum menutup dialog. Jika nilai belum valid atau penyimpanan gagal, isian tetap tersedia untuk diperbaiki atau dicoba simpan lagi. Pada jendela pendek, gulir halaman untuk menjangkau ringkasan. Penerimaan barang tetap dicatat terpisah setelah faktur dicatat.

**English:** Saved drafts, New purchase, Discard draft, and save status are in the top toolbar. Supplier and bill details sit above the item table. Notes are below left; discounts, VAT, outgoing payments, totals, and Review purchase are below right. Select Outgoing payments to enter payments; Close saves changes before dismissing the dialog. Invalid or failed saves keep entries available for correction or retry. In short windows, scroll the page to reach the summary. Goods receiving remains a separate action after the bill is recorded.

## Impor pemasok dan saldo awal utang / Supplier CSV import

**Indonesia:** Admin membuka Pembelian → Pemasok → Impor CSV pemasok. Pilih CSV UTF-8, tinjau perubahan pemasok, tanggal, jumlah saldo awal, dan pesan kesalahan. Jika nomor telepon dipakai beberapa pemasok, setujui peringatannya sebelum impor. Aplikasi membuat cadangan tervalidasi sebelum menyimpan seluruh file sekaligus; kesalahan satu baris membatalkan semuanya.

Kolom: `external_id,name,phone_number,email,address,is_active,as_of_date,opening_balance`. ID eksternal wajib dan unik; status `true` atau `false`. Jumlah utang menggunakan rupiah bulat tanpa pemisah ribuan. Dua kolom keuangan kosong berarti hanya memperbarui pemasok. Isian kontak kosong mempertahankan nilai lama. Saldo nol valid. Impor ulang dengan tanggal/jumlah asli yang sama tidak menambah utang atau menghapus pembayaran; tanggal/jumlah asli berbeda ditolak. Pemasok dicocokkan hanya melalui ID eksternal, bukan nama/telepon.

CSV referensi `references/supplier-import.csv` berisi tiga pemasok dengan saldo per 2026-10-31. Kolom utang bernama `opening_balance`; total Rp1.284.002.694. Kota digabung ke alamat; digit telepon dipertahankan dari sumber. `Expr2` yang belum diketahui artinya dan seluruhnya nol tidak disertakan.

Buka Pembelian → Utang & Pengembalian Dana → Sumber utang → Saldo awal utang. Pilih pemasok untuk melihat saldo asli, pembayaran, dan sisa utang. Admin/kasir dapat mencatat pembayaran, termasuk bagi pemasok nonaktif; tinjau jumlah dan metode sebelum konfirmasi. Pembayaran tidak boleh melebihi sisa utang dan tidak dapat diedit. Saldo asli tidak dihitung sebagai pembelian baru, stok, atau PPN. Pembayaran masuk ke total pembayaran keluar pada Laporan Harian. Jangan mengimpor utang yang sudah tercatat melalui faktur pembelian, agar tidak dihitung dua kali.

**English:** An admin opens Purchase → Suppliers → Import supplier CSV. Choose a UTF-8 CSV and review supplier changes, opening dates/amounts, and validation messages. Acknowledge shared-phone warnings when applicable. A validated safety backup precedes one atomic import; any invalid row prevents the entire file from committing.

Use the headers above. External IDs must be unique; active status is `true` or `false`; amounts are whole rupiah without grouping separators. Leave both financial columns blank for contact-only updates. Blank contact fields preserve existing values. Zero openings are valid. Reimporting identical original dates/amounts preserves payments and adds no debt; changing an original is rejected. Matching uses external IDs exclusively.

The prepared reference CSV contains three suppliers as of 2026-10-31, totaling Rp1,284,002,694. City is appended to address and source phone digits are preserved. The unidentified all-zero `Expr2` column is excluded.

Open Payables & Refunds → Payable source → Opening payables, then select a supplier to review the original, paid, and outstanding amounts. Admins and cashiers can review and confirm payments, including for inactive suppliers. Overpayments are rejected and posted payments are immutable. Original openings do not create purchases, inventory, or VAT; repayments appear in daily outgoing-payment totals. Exclude debt already represented by purchase invoices to avoid double-counting.
