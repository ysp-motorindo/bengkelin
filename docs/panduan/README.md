# Dokumentasi pengguna Bengkelin

- [Buka panduan HTML](onboarding.html)
- [Unduh PDF](../../output/pdf/panduan-setup-dan-impor-data.pdf)
- [Buka manual operasional kasir dan admin](manual-operasional.html)
- [Unduh PDF manual operasional](../../output/pdf/manual-operasional-bengkelin.pdf)

- [Tambahan Sales dan Ekspedisi: impor dan operasional](../sales-ekspedisi.md) — kode tetap, impor ulang tanpa penghapusan, pilihan transaksi opsional, dan nama historis faktur.

## Panduan onboarding

Panduan ditujukan untuk admin bengkel, mulai dari pembukaan pertama aplikasi yang sudah terpasang hingga impor katalog dan pelanggan. Contoh menggunakan `data/import-ready/catalog-mmb.csv` dan `customers-mmb.csv`.

**Dokumen internal:** screenshot memuat data pelanggan MMB asli sesuai kebutuhan panduan. Identitas bengkel pada formulir setup adalah contoh. Screenshot diambil dari aplikasi Bengkelin 1.0.0 pada macOS, menggunakan database sementara; database operasional tidak digunakan.

## Mengubah dan mencetak

`onboarding.html` adalah sumber dokumen. Gambar dan font Plus Jakarta Sans disematkan sebagai data URI, sehingga tidak membutuhkan koneksi internet atau berkas pendamping. Lisensi SIL Open Font License tersedia di bagian paling bawah HTML, di luar halaman cetak.

Untuk perubahan teks, edit HTML dengan mempertahankan struktur setiap `section.page`, lalu buka hasilnya di browser. Untuk menyimpan PDF, pilih A4, skala 100%, margin nol, aktifkan pencetakan latar belakang, dan matikan header/footer bawaan browser. Hasil harus tetap 16 halaman, tanpa isi yang menimpa nomor halaman. Periksa setiap halaman setelah mengekspor. PDF yang disertakan diekspor menggunakan Electron `printToPDF` dengan `preferCSSPageSize` dan `printBackground` aktif.

Jika antarmuka atau data contoh berubah, ambil ulang screenshot melalui aplikasi dengan profil sementara (`BENGKELIN_DATA_DIR`, hanya untuk build yang tidak dipaketkan). Jangan memakai profil operasional untuk menyiapkan screenshot.

## Pemeriksaan data

Angka pembanding pada database baru: 422 produk stok, 91 jasa, 64.954 unit stok awal, serta 505 pelanggan (504 aktif, satu nonaktif). Pratinjau katalog menampilkan 366 titik harga baru, termasuk 91 harga jasa.

Pengujian yang digunakan untuk memeriksa isi panduan:

```sh
npm run build:app
npm run test:integration -- tests/integration/mmb-onboarding.test.ts
npx playwright test tests/e2e/auth.spec.ts tests/e2e/catalog-transfer.spec.ts tests/e2e/customer-transfer.spec.ts
```

Pengambilan screenshot juga menjalankan impor kedua CSV MMB melalui UI dan membuat cadangan manual pada profil sementara. Validasi dokumen mencakup font dan gambar tertanam, tautan daftar isi, pembukaan tanpa permintaan jaringan, tampilan HTML pada lebar 390 px, serta render dan pemeriksaan setiap halaman PDF.

Hasil pemeriksaan 27 Oktober 2026: dua uji integrasi MMB dan delapan uji E2E lulus. Dokumen akhir berisi 16 halaman A4 dengan 16 screenshot; font tertanam dalam HTML dan PDF. Pemeriksaan tata letak memastikan isi tidak menimpa footer. Seluruh halaman PDF dirender dan diperiksa secara visual. Pengujian aplikasi dilakukan pada macOS, bukan pada database operasional.

Panduan tidak mencakup instalasi, seluruh alur transaksi, atau pengujian printer fisik. Harga yang belum terverifikasi dalam data sumber tetap perlu dikonfirmasi oleh penanggung jawab bengkel.

## Manual operasional kasir dan admin

Manual operasional melanjutkan onboarding: transaksi dan draf, pelanggan/kendaraan, harga dan diskon, pembayaran serta piutang, nota, riwayat dan VOID, laporan harian, katalog/barcode/harga, persediaan, referensi, akun, pengaturan, pencadangan, dan pemulihan. Checklist harian dan penanganan kendala disertakan. Setiap prosedur menjelaskan peran, langkah, dan hasil yang perlu diperiksa.

Sumbernya `manual-operasional.html`, berupa 38 halaman A4 dengan 32 screenshot dan font Plus Jakarta Sans tertanam. Buka HTML tanpa internet; simpan `onboarding.html` di folder yang sama agar tautan ke buku sebelumnya tetap tersedia. Pengaturan cetak dan cara mengubah dokumen mengikuti petunjuk di atas, tetapi jumlah halaman manual adalah 38. Sesudah perubahan, perbarui daftar isi dan footer jika jumlah halaman berubah, ekspor PDF, lalu render dan periksa setiap halaman.

Screenshot manual diambil dari aplikasi 1.0.0 pada macOS dengan profil sementara berisi impor kedua CSV MMB. Akun Kasir Latihan, Pelanggan Latihan, kendaraan B 1234 DEMO, barcode, dan transaksi pada buku dibuat khusus untuk latihan. Kode barcode latihan bukan master operasional. Database operasional tidak digunakan atau diubah. Manual tetap untuk penggunaan internal.

Contoh yang diperiksa: aki AKI-YMP-X012 Rp141.500 + jasa Rp10.000 = Rp151.500; pembayaran awal Rp100.000 dan pelunasan Rp51.500; stok 18 menjadi 17. Faktur tanpa pembayaran yang terpisah menurunkan stok 17 menjadi 16, lalu VOID mengembalikannya menjadi 17. Penerimaan 3 unit menghasilkan 20, dan contoh opname mengubahnya menjadi 19.

Pemeriksaan aplikasi untuk manual:

```sh
npm run build:app
npx playwright test tests/e2e/cashier-workflow.spec.ts tests/e2e/finalization.spec.ts tests/e2e/invoice-history.spec.ts tests/e2e/daily-report.spec.ts tests/e2e/printing.spec.ts tests/e2e/inventory.spec.ts tests/e2e/master-data.spec.ts tests/e2e/catalog.spec.ts tests/e2e/backup.spec.ts tests/e2e/restore.spec.ts
```

Build dan 12 uji E2E lulus pada 27 Oktober 2026. Pengambilan screenshot memeriksa angka contoh melalui UI dan hasil stok. Pratinjau restore pada screenshot dibatalkan; pemulihan sebenarnya diverifikasi oleh E2E pada profil uji terpisah. Tidak ada pengujian printer fisik, replay manual di Windows, atau pengujian seluruh rangkaian aplikasi.

HTML akhir diperiksa tanpa permintaan jaringan, dengan 32 gambar dan font berhasil dimuat, tautan daftar isi valid, serta lebar 390 px tanpa gulir horizontal. PDF akhir diperiksa sebagai 38 halaman A4 dengan font tertanam, teks dan nomor halaman sesuai, tanpa konten menimpa footer. Seluruh halaman dirender dan diperiksa secara visual; review independen terhadap isi dan sumber aplikasi tidak menemukan masalah substantif yang tersisa.

## Stock locations / Lokasi stok — 1 November 2026

Read [stock-locations.md](stock-locations.md) alongside the existing onboarding and operating manual. It supersedes their location-free inventory and catalog-import examples: set up active stock locations first, keep `stock_location` as text in CSV files, and select a location for stock operations and catalog export. Existing invoices and stock history are migrated to `01`; fresh installations do not seed Gudang.

Baca [stock-locations.md](stock-locations.md) bersama onboarding dan manual operasional. Panduan ini memperbarui contoh stok dan impor katalog lama: siapkan lokasi aktif terlebih dahulu, simpan `stock_location` sebagai teks dalam CSV, dan pilih lokasi untuk mutasi stok serta ekspor katalog. Faktur dan riwayat lama dimigrasikan ke `01`; instalasi baru tidak membuat Gudang.

## Panduan pembelian

Lihat [Pembelian dari pemasok](pembelian.md) sebagai pelengkap manual operasional untuk faktur pemasok, penerimaan sebagian, retur/kredit, pembayaran, pengembalian dana, laporan, cetak, dan cadangan. Panduan berisi ringkasan Bahasa Indonesia dan English.

## Navigasi dua tingkat / Two-level navigation

| Area / Bagian | Destinations / Tujuan |
|---|---|
| Penjualan / Sales | Penjualan Baru / New Sale; Riwayat Penjualan / Sales History; Piutang / Receivables |
| Pembelian / Purchase | Buat Pembelian / New Purchase; Riwayat Pembelian / Purchase History; Penerimaan / Receiving; Utang & Pengembalian Dana / Payables & Refunds; Pemasok / Suppliers |
| Katalog & Stok / Catalog & Stock | Katalog & Harga / Catalog & Prices; Persediaan / Inventory; Impor/Ekspor Katalog / Catalog Import/Export (admin) |
| Pelanggan & Kendaraan / Customers & Vehicles | Langsung / Direct |
| Laporan Harian / Daily Report | Langsung / Direct |
| Administrasi / Administration (admin) | Data Referensi / Reference Data; Kasir / Cashiers; Pengaturan / Settings |

Switching areas opens the first destination and preserves transaction drafts. Clicking the current area leaves its current screen in place. Existing HTML/PDF manual screenshots show the older navigation; use this map for current paths.

Berpindah bagian membuka tujuan pertama dan mempertahankan draf transaksi. Mengeklik bagian aktif mempertahankan layar saat ini. Screenshot manual HTML/PDF sebelumnya menampilkan navigasi lama; gunakan peta ini untuk jalur terbaru.
