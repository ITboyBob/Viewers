// Small, clearly named synthetic CT series for reproducible tool demonstrations.
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../demo-data');
fs.mkdirSync(output, { recursive: true });
const ctClass = '1.2.840.10008.5.1.4.1.1.2';
const study = '2.25.314159265358979323846264338327950288';
const series = '2.25.271828182845904523536028747135266249';
function element(group, tag, vr, value) {
  let data;
  if (Buffer.isBuffer(value)) data = value;
  else if (vr === 'US') {
    data = Buffer.alloc(2);
    data.writeUInt16LE(value);
  } else if (vr === 'UL') {
    data = Buffer.alloc(4);
    data.writeUInt32LE(value);
  } else data = Buffer.from(String(value), 'ascii');
  if (data.length % 2)
    data = Buffer.concat([data, Buffer.from([vr === 'UI' || vr === 'OB' ? 0 : 32])]);
  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(tag, 2);
  header.write(vr, 4, 'ascii');
  if (long) header.writeUInt32LE(data.length, 8);
  else header.writeUInt16LE(data.length, 6);
  return Buffer.concat([header, data]);
}
for (let slice = 0; slice < 8; slice++) {
  const sop = `2.25.1618033988749894848204586834365638${slice + 1}`;
  const meta = Buffer.concat([
    element(2, 1, 'OB', Buffer.from([0, 1])),
    element(2, 2, 'UI', ctClass),
    element(2, 3, 'UI', sop),
    element(2, 0x10, 'UI', '1.2.840.10008.1.2.1'),
    element(2, 0x12, 'UI', '2.25.141421356237309504880168872420969807'),
    element(2, 0x13, 'SH', 'MASK_DEMO'),
  ]);
  const pixels = Buffer.alloc(128 * 128 * 2);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const body = ((x - 64) / 53) ** 2 + ((y - 64) / 49) ** 2 <= 1;
      let hu = body ? 30 : -1000;
      const leftRadius = Math.hypot(x - 40, y - 64);
      const ring = leftRadius <= 20 && leftRadius >= 9;
      const lobes = Math.hypot(x - 88, y - 48) <= 10 || Math.hypot(x - 88, y - 80) <= 10;
      const bridge = x >= 87 && x <= 89 && y >= 48 && y <= 80;
      if (ring || lobes || bridge) hu = 600;
      pixels.writeInt16LE(hu, (y * 128 + x) * 2);
    }
  const dataset = [
    element(8, 8, 'CS', 'DERIVED\\SECONDARY\\AXIAL'),
    element(8, 0x16, 'UI', ctClass),
    element(8, 0x18, 'UI', sop),
    element(8, 0x20, 'DA', '20200101'),
    element(8, 0x30, 'TM', '120000'),
    element(8, 0x50, 'SH', 'MASKTEST'),
    element(8, 0x60, 'CS', 'CT'),
    element(8, 0x70, 'LO', 'Synthetic Test Data'),
    element(8, 0x1030, 'LO', 'Synthetic Mask Tools Demo'),
    element(8, 0x103e, 'LO', 'Synthetic CT Phantom - Not Patient Data'),
    element(0x10, 0x10, 'PN', 'SYNTHETIC^MASK_DEMO'),
    element(0x10, 0x20, 'LO', 'SYNTHETIC-MASK-001'),
    element(0x18, 0x50, 'DS', '2'),
    element(0x18, 0x88, 'DS', '2'),
    element(0x18, 0x5100, 'CS', 'HFS'),
    element(0x20, 0x0d, 'UI', study),
    element(0x20, 0x0e, 'UI', series),
    element(0x20, 0x10, 'SH', 'MASKDEMO'),
    element(0x20, 0x11, 'IS', '1'),
    element(0x20, 0x13, 'IS', String(slice + 1)),
    element(0x20, 0x32, 'DS', `0\\0\\${slice * 2}`),
    element(0x20, 0x37, 'DS', '1\\0\\0\\0\\1\\0'),
    element(0x20, 0x52, 'UI', '2.25.173205080756887729352744634150587236'),
    element(0x20, 0x1041, 'DS', String(slice * 2)),
    element(0x28, 2, 'US', 1),
    element(0x28, 4, 'CS', 'MONOCHROME2'),
    element(0x28, 0x10, 'US', 128),
    element(0x28, 0x11, 'US', 128),
    element(0x28, 0x30, 'DS', '1\\1'),
    element(0x28, 0x100, 'US', 16),
    element(0x28, 0x101, 'US', 16),
    element(0x28, 0x102, 'US', 15),
    element(0x28, 0x103, 'US', 1),
    element(0x28, 0x1050, 'DS', '200'),
    element(0x28, 0x1051, 'DS', '1400'),
    element(0x28, 0x1052, 'DS', '0'),
    element(0x28, 0x1053, 'DS', '1'),
    element(0x28, 0x1054, 'LO', 'HU'),
    element(0x7fe0, 0x10, 'OW', pixels),
  ];
  fs.writeFileSync(
    path.join(output, `synthetic-ct-${String(slice + 1).padStart(3, '0')}.dcm`),
    Buffer.concat([
      Buffer.alloc(128),
      Buffer.from('DICM'),
      element(2, 0, 'UL', meta.length),
      meta,
      ...dataset,
    ])
  );
}
console.log(`Generated 8 synthetic DICOM slices in ${output}`);
