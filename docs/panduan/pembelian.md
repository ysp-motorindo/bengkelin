# Pembelian dari pemasok

Menu **Pembelian** berada tepat setelah **Penjualan**. Kasir dan admin dapat menggunakannya. Pembelian, pembayaran, dan penerimaan barang dicatat terpisah.

## Mencatat faktur pemasok

1. Buka Pembelian. Draf terbaru dilanjutkan otomatis; jika belum ada draf, aplikasi membuat satu draf. Gunakan Draf tersimpan untuk melanjutkan atau membuang draf lain.
2. Pilih pemasok. Gunakan Tambah pemasok bila belum tersedia. Nama wajib; telepon, email, dan alamat opsional. Pemasok nonaktif tetap tersimpan untuk riwayat dan penyelesaian faktur lama.
3. Isi nomor faktur pemasok jika ada, tanggal, tempo pembayaran, dan catatan.
4. Cari/pindai barang atau tambahkan barang/jasa khusus. **Harga beli selalu kosong saat barang baru dipilih.** Isi jumlah dan harga beli; harga jual katalog tidak berubah.
5. Isi diskon barang D1–D4 dan satu diskon faktur **Disc** jika diperlukan, lalu PPN termasuk. Draf lama dengan beberapa diskon faktur tetap dipertahankan; pilih **Ganti diskon** hanya jika ingin menggantinya dengan satu diskon. Lengkapi semua harga untuk menghitung total. Harga nol memerlukan persetujuan saat tinjauan.
6. Buka Pembayaran keluar dan isi pembayaran yang benar-benar sudah dilakukan. Pilih **Terapkan** untuk menyimpan; **Batal**, Escape, atau Tutup membuang perubahan yang belum diterapkan. Hapus semua baris lalu Terapkan untuk faktur belum dibayar. Jika penyimpanan gagal, isian tetap tersedia untuk dicoba kembali.
7. Tinjau lalu catat faktur. Dialog hasil menampilkan nomor `PUR-...`, total, status pembayaran/penerimaan, serta pilihan cetak. Pilih **Pembelian baru** untuk transaksi berikutnya atau **Lihat faktur** untuk membuka rincian dan mencatat penerimaan. Menutup dialog hasil memulai pembelian baru. Jika draf baru gagal dibuat, hasil faktur tetap tersedia untuk dicoba kembali. Mencatat faktur tidak menambah stok.

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

Open **Purchase**, immediately after Sales. Select or create a supplier, enter the supplier bill details, then select products or custom goods/services. Every new product starts with a blank purchase price. Enter quantities, prices, item discounts D1–D4, one bill-level Disc percentage, and inclusive VAT. Existing multi-stage bill discounts remain intact until Replace discount is explicitly selected. Outgoing payments stay local until Apply; Cancel, Escape, and Close discard unapplied changes. Remove all payment rows and Apply to leave the bill unpaid. Review and record the bill. The recorded-result dialog offers printing, New purchase, and View bill. Closing the result starts a new purchase; failed creation keeps the recorded bill available for retry. Finalization does not add stock or alter catalog prices.

Record deliveries separately, including partial quantities and the location of each delivery. Only tracked products add stock. Check the receipt number, location, and quantity still expected. Reverse an incorrect whole receipt before any of its quantities have been credited.

Supplier credits can cancel undelivered quantities or return quantities from a specific receipt. Returns remove stock at the original location and use the original net prices and tax. Credits stay on their original bill. Returned quantities do not reopen delivery expectations. A credit never implies that cash has been refunded: record a refund only when money is actually received.

Use purchase history to review receipts, payments, credits, refunds, and the independent settlement/receiving states. Posted payments, credits, and refunds are immutable; review entries before confirming. Failed requests preserve entries for retry. Negative-stock actions require acknowledgment.

Print bills in A4/thermal and receipts/credits in A4, or export A4 PDFs. Print failures leave the recorded transaction intact. Daily reports keep purchasing separate from sales and use each activity's posting time. Backups include purchasing, and restore protects previously issued document numbers.

Navigation: Purchase → New Purchase / Purchase History / Receiving / Payables & Refunds / Suppliers. Switching back to Purchase opens the editor and retains your draft.

Navigasi: Pembelian → Buat Pembelian / Riwayat Pembelian / Penerimaan / Utang & Pengembalian Dana / Pemasok. Kembali ke Pembelian membuka editor dan mempertahankan draf.

## Tata letak ringkas / Compact workspace

**Indonesia:** Draf tersimpan dan Pembelian baru berada di kiri bilah atas; indikator simpan di kanan. Buang draf berada di dialog Draf tersimpan dan memerlukan konfirmasi. Pemasok menggunakan satu kolom pencarian/pilihan dengan navigasi keyboard. Tabel barang mengikuti penjualan, dengan lebar kolom yang dapat diubah dan D1–D4 terpisah. Isian jumlah, harga, dan diskon barang disimpan saat berpindah kolom; Escape membatalkan perubahan yang belum dikirim. Catatan di kiri bawah; satu Disc faktur, PPN, pembayaran keluar, total, dan Tinjau pembelian di kanan bawah. Pembayaran hanya disimpan dengan Terapkan. Pada jendela pendek, gulir halaman untuk menjangkau ringkasan. Penerimaan tetap terpisah melalui Lihat faktur.

**English:** Saved drafts and New purchase sit on the left of the top toolbar; save status sits on the right. Discard is in the saved-drafts dialog and requires confirmation. Supplier selection uses one searchable, keyboard-operable picker. The item table follows sales with resizable columns and separate D1–D4 cells. Quantity, price, and item-discount edits commit on blur; Escape cancels unsent changes. Notes sit below left; one bill Disc, VAT, outgoing payments, totals, and Review purchase sit below right. Payments are saved only with Apply. In short windows, scroll to reach the summary. Receiving remains separate through View bill.
