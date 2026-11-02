// Public real CT pixels and DICOM JSON are repackaged as local Part 10 files; no pixels are synthesized.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const dcmjs = require('dcmjs'),
  dicomParser = require('dicom-parser');
const root = path.resolve(__dirname, '../.cache/real-dicom');
const server = 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb';
const cases = [
  {
    key: 'lung-ct',
    name: '公开肺部 CT',
    study: '1.3.6.1.4.1.32722.99.99.62087908186665265759322018723889952421',
    series: '1.3.6.1.4.1.32722.99.99.12747108866907265023948393821781944475',
    expectedFrames: 114,
  },
  {
    key: 'abdomen-ct',
    name: '公开腹部静脉期 CT',
    study: '1.3.6.1.4.1.14519.5.2.1.256467663913010332776401703474716742458',
    series: '1.3.6.1.4.1.14519.5.2.1.40445112212390159711541259681923198035',
    expectedFrames: 52,
  },
];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const testDate =
  process.env.MASK_TEST_DATE ||
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
async function read(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 16 * 1024 * 1024) throw Error('Response too large');
      return b;
    } catch (e) {
      if (attempt === 2) throw new Error('Download failed: ' + url, { cause: e });
    }
}
function pixelsOf(bytes, size) {
  if (bytes.length === size) return bytes;
  const start = bytes.indexOf(Buffer.from('\r\n\r\n')) + 4,
    end = start + size;
  if (
    start < 4 ||
    bytes.length < end ||
    !bytes.subarray(end).toString('ascii').startsWith('\r\n--')
  )
    throw Error('Expected uncompressed little-endian DICOMweb frame');
  return bytes.subarray(start, end);
}
function info(bytes) {
  const ds = dicomParser.parseDicom(new Uint8Array(bytes)),
    nums = t => ds.string(t)?.split('\\').map(Number);
  return {
    sopInstanceUID: ds.string('x00080018'),
    studyInstanceUID: ds.string('x0020000d'),
    seriesInstanceUID: ds.string('x0020000e'),
    modality: ds.string('x00080060'),
    manufacturer: ds.string('x00080070'),
    rows: ds.uint16('x00280010'),
    columns: ds.uint16('x00280011'),
    slope: Number(ds.string('x00281053') || 1),
    intercept: Number(ds.string('x00281052') || 0),
    bitsStored: ds.uint16('x00280101'),
    pixelRepresentation: ds.uint16('x00280103'),
    position: nums('x00200032'),
    orientation: nums('x00200037'),
    pixelSpacing: nums('x00280030'),
    identityRemoved: ds.string('x00120062'),
    transferSyntaxUID: ds.string('x00020010'),
  };
}
function pack(metadata, pixels) {
  const signed = metadata['00280103'].Value[0] === 1;
  function tags(source) {
    const result = {};
    for (const [tag, entry] of Object.entries(source)) {
      // Private deidentification/indexing fields are not needed for viewer regression.
      if (parseInt(tag.slice(0, 4), 16) % 2 || tag === '7FE00010' || entry.BulkDataURI) continue;
      const item = { ...entry };
      item.vr ||=
        dcmjs.data.DicomMetaDictionary.dictionary[
          '(' + tag.slice(0, 4) + ',' + tag.slice(4) + ')'
        ]?.vr;
      if (!item.vr) continue;
      if (!item.Value && !item.InlineBinary) item.Value = [];
      if (item.Value && !Array.isArray(item.Value)) item.Value = [item.Value];
      if (item.vr === 'US|SS') item.vr = signed ? 'SS' : 'US';
      if (item.vr === 'OB|OW') item.vr = 'OW';
      if (item.InlineBinary) {
        const b = Buffer.from(item.InlineBinary, 'base64'),
          numeric = {
            US: [2, 'readUInt16LE'],
            SS: [2, 'readInt16LE'],
            UL: [4, 'readUInt32LE'],
            SL: [4, 'readInt32LE'],
            FL: [4, 'readFloatLE'],
            FD: [8, 'readDoubleLE'],
          }[item.vr];
        item.Value = numeric
          ? Array.from({ length: b.length / numeric[0] }, (_, i) => b[numeric[1]](i * numeric[0]))
          : [b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)];
        delete item.InlineBinary;
      }
      if (item.vr === 'SQ') item.Value = (item.Value || []).map(tags);
      if (item.vr === 'PN')
        item.Value = (item.Value || []).map(v =>
          typeof v === 'string'
            ? v
            : [v.Alphabetic || '', v.Ideographic || '', v.Phonetic || '']
                .join('=')
                .replace(/=+$/, '')
        );
      if (['CS', 'DS', 'IS', 'UI', 'SH', 'LO'].includes(item.vr) && item.Value)
        item.Value = item.Value.flatMap(v => (typeof v === 'string' ? v.split('\\') : v));
      result[tag] = item;
    }
    return result;
  }
  const meta = {
    FileMetaInformationVersion: { vr: 'OB', Value: [new Uint8Array([0, 1]).buffer] },
    MediaStorageSOPClassUID: { vr: 'UI', Value: metadata['00080016'].Value },
    MediaStorageSOPInstanceUID: { vr: 'UI', Value: metadata['00080018'].Value },
    TransferSyntaxUID: { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    ImplementationClassUID: { vr: 'UI', Value: ['2.25.314159265358979323846264338327950288'] },
    ImplementationVersionName: { vr: 'SH', Value: ['OHIF_TEST_DATA1'] },
  };
  const headerTags = {
    FileMetaInformationVersion: '00020001',
    MediaStorageSOPClassUID: '00020002',
    MediaStorageSOPInstanceUID: '00020003',
    TransferSyntaxUID: '00020010',
    ImplementationClassUID: '00020012',
    ImplementationVersionName: '00020013',
  };
  const header = Object.fromEntries(
    Object.entries(meta).map(([name, value]) => [headerTags[name], value])
  );
  const dict = new dcmjs.data.DicomDict(header);
  dict.dict = tags(metadata);
  dict.dict['00080005'] = { vr: 'CS', Value: ['ISO_IR 192'] };
  dict.dict['7FE00010'] = {
    vr: 'OW',
    Value: [pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength)],
  };
  let encoded;
  try {
    encoded = dict.write();
  } catch (error) {
    const empty = new dcmjs.data.DicomDict(header);
    empty.dict = {};
    empty.write();
    for (const [tag, value] of Object.entries(dict.dict))
      try {
        const check = new dcmjs.data.DicomDict(header);
        check.dict = { [tag]: value };
        check.write();
      } catch (cause) {
        throw new Error(
          'Cannot package source tag ' +
            tag +
            ' VR ' +
            value.vr +
            ' valueTypes ' +
            JSON.stringify(value.Value?.map(v => typeof v)),
          { cause }
        );
      }
    throw error;
  }
  const bytes = Buffer.from(encoded),
    parsed = dicomParser.parseDicom(new Uint8Array(bytes)),
    e = parsed.elements.x7fe00010;
  if (!bytes.subarray(e.dataOffset, e.dataOffset + pixels.length).equals(pixels))
    throw Error('Packaging changed pixels');
  return bytes;
}
(async () => {
  fs.mkdirSync(root, { recursive: true });
  const keys = process.argv.slice(2),
    selected = keys.length ? cases.filter(c => keys.includes(c.key)) : cases;
  if (!selected.length || keys.some(k => !cases.some(c => c.key === k)))
    throw Error('Use lung-ct or abdomen-ct');
  const reports = [];
  let total = 0;
  for (const item of selected) {
    const base = server + '/studies/' + item.study + '/series/' + item.series;
    const metadataBytes = await read(base + '/metadata'),
      metadata = JSON.parse(metadataBytes.toString());
    if (
      metadata.length !== item.expectedFrames ||
      metadata.some(m => m['00120062']?.Value?.[0] !== 'YES')
    )
      throw Error('Pinned deidentified sample changed');
    const rawSize = metadata.reduce(
      (s, m) => s + (m['00280010'].Value[0] * m['00280011'].Value[0] * m['00280100'].Value[0]) / 8,
      0
    );
    if (total + rawSize > 96 * 1024 * 1024) throw Error('Samples exceed 96 MiB budget');
    const folder = path.join(root, item.key);
    fs.mkdirSync(folder, { recursive: true });
    const files = new Array(metadata.length);
    let next = 0,
      done = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        while (next < metadata.length) {
          const i = next++,
            m = metadata[i],
            uid = m['00080018'].Value[0],
            file = String(i + 1).padStart(4, '0') + '.dcm',
            target = path.join(folder, file),
            url = base + '/instances/' + uid + '/frames/1';
          let bytes, pixelSha256;
          if (fs.existsSync(target)) {
            bytes = fs.readFileSync(target);
            const data = info(bytes);
            if (data.sopInstanceUID !== uid || data.seriesInstanceUID !== item.series)
              throw Error('Cached source mismatch');
            const ds = dicomParser.parseDicom(new Uint8Array(bytes)),
              e = ds.elements.x7fe00010;
            pixelSha256 = sha(bytes.subarray(e.dataOffset, e.dataOffset + e.length));
          } else {
            const size =
              (m['00280010'].Value[0] * m['00280011'].Value[0] * m['00280100'].Value[0]) / 8;
            const response = await read(url, {
                Accept:
                  'multipart/related; type="application/octet-stream"; transfer-syntax="1.2.840.10008.1.2.1"',
              }),
              pixels = pixelsOf(response, size);
            pixelSha256 = sha(pixels);
            bytes = pack(m, pixels);
            fs.writeFileSync(target, bytes);
          }
          files[i] = {
            file,
            sourceFrameUrl: url,
            bytes: bytes.length,
            sha256: sha(bytes),
            pixelSha256,
            ...info(bytes),
          };
          done++;
          if (done % 20 === 0 || done === metadata.length)
            console.log(item.key + ': ' + done + '/' + metadata.length + ' complete');
        }
      })
    );
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    total += bytes;
    const provenance = {
      ...item,
      testDate,
      sourcePage: 'https://viewer.ohif.org/',
      metadataUrl: base + '/metadata',
      transport:
        'DICOMweb metadata + uncompressed frames repackaged as Explicit VR Little Endian Part 10. Source pixels, UIDs, geometry and rescale values preserved. Not a byte-identical original Part 10 download.',
      metadataSha256: sha(metadataBytes),
      bytes,
      files,
    };
    fs.writeFileSync(path.join(folder, 'provenance.json'), JSON.stringify(provenance, null, 2));
    reports.push({ key: item.key, frames: files.length, bytes, folder });
    console.log(JSON.stringify(reports.at(-1)));
    fs.writeFileSync(path.join(root, 'downloaded-cases.json'), JSON.stringify(reports, null, 2));
  }
  console.log(
    'Complete real CT samples: ' +
      (total / 1024 / 1024).toFixed(2) +
      ' MiB; files remain local in ignored .cache/real-dicom.'
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
