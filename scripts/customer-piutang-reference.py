"""Reconcile the preserved MMB workbook and generate/check the opening CSV.

Uses only Python's standard library; never modifies the source workbook.
"""
import csv
import hashlib
import io
from collections import defaultdict
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'docs/Saldo Piutang 30 September 2026.xlsx'
OUTPUT = ROOT / 'data/import-ready/customer-piutang-mmb-2026-09-30.csv'
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def reconcile():
    with zipfile.ZipFile(SOURCE) as archive:
        strings = [''.join(x.itertext()) for x in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]

        def sheet(number):
            result = {}
            for cell in ET.fromstring(archive.read(f'xl/worksheets/sheet{number}.xml')).findall('.//m:c', NS):
                value = cell.find('m:v', NS)
                if value is not None:
                    result[cell.attrib['r']] = strings[int(value.text)] if cell.attrib.get('t') == 's' else value.text
            return result

        summary, detail = sheet(1), sheet(2)
        groups = defaultdict(int)
        counts = defaultdict(int)
        for row in range(2, 48):
            name = detail[f'C{row}'].strip()
            groups[name] += int(detail[f'E{row}'])
            counts[name] += 1
        rows = []
        for row in range(5, 16):
            name = summary[f'B{row}'].strip()
            amount = int(summary[f'F{row}'])
            assert groups.pop(name) == amount, f'{name}: detail differs from SUM closing balance'
            rows.append([summary[f'A{row}'], name, '2026-09-30', str(amount)])
        assert not groups, 'Unmatched detail customers'
        assert len(rows) == 11 and sum(counts.values()) == 46
        assert len({r[0] for r in rows}) == 11
        assert sum(int(r[3]) for r in rows) == int(summary['F17']) == int(detail['E50']) == 243750942
        return rows, counts


if __name__ == '__main__':
    rows, counts = reconcile()
    buffer = io.StringIO(newline='')
    writer = csv.writer(buffer, lineterminator='\n')
    writer.writerow(['external_id', 'customer_name', 'as_of_date', 'opening_balance'])
    writer.writerows(rows)
    expected = buffer.getvalue()
    if '--check' in sys.argv:
        assert OUTPUT.read_text() == expected, 'Reference CSV differs from reconciled workbook'
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(expected)
    print('11 customers; 46 detail rows; total 243750942')
    print('Workbook SHA-256:', hashlib.sha256(SOURCE.read_bytes()).hexdigest())
    for external_id, name, _, amount in rows:
        print(f'{external_id}: {counts[name]} detail rows = {amount}')
