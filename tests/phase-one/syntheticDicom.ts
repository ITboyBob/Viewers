import { randomUUID } from 'node:crypto';
import dcmjs from 'dcmjs';
const uid = () => `2.25.${BigInt('0x' + randomUUID().replace(/-/g, '')).toString()}`;
const ctClass = '1.2.840.10008.5.1.4.1.1.2';
/** 仅在内存构造明确标识的合成CT，不读取或下载任何患者影像。 */
export function syntheticSeries(count = 8) {
  const study = uid(),
    series = uid(),
    frame = uid();
  const files = Array.from({ length: count }, (_, i) => {
    const sop = uid();
    const pixels = new Uint16Array(32 * 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        pixels[y * 32 + x] = Math.hypot(x - 16, y - 16) <= 11 ? 1124 : 24;
      }
    }
    const meta = {
      '00020001': { vr: 'OB', Value: [new Uint8Array([0, 1]).buffer] },
      '00020002': { vr: 'UI', Value: [ctClass] },
      '00020003': { vr: 'UI', Value: [sop] },
      '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
      '00020012': { vr: 'UI', Value: ['2.25.141421356237309504880168872420969807'] },
    };
    const dict = new dcmjs.data.DicomDict(meta);
    dict.dict = {
      '00080008': { vr: 'CS', Value: ['DERIVED', 'SECONDARY', 'AXIAL'] },
      '00080016': { vr: 'UI', Value: [ctClass] },
      '00080018': { vr: 'UI', Value: [sop] },
      '00080020': { vr: 'DA', Value: ['20200101'] },
      '00080030': { vr: 'TM', Value: ['120000'] },
      '00080060': { vr: 'CS', Value: ['CT'] },
      '00081030': { vr: 'LO', Value: ['Synthetic Import Test - Not Patient Data'] },
      '0008103E': { vr: 'LO', Value: ['Synthetic CT'] },
      '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^IMPORT_TEST' }] },
      '00100020': { vr: 'LO', Value: ['SYNTHETIC-IMPORT'] },
      '00180050': { vr: 'DS', Value: [2] },
      '00180088': { vr: 'DS', Value: [2] },
      '00185100': { vr: 'CS', Value: ['HFS'] },
      '0020000D': { vr: 'UI', Value: [study] },
      '0020000E': { vr: 'UI', Value: [series] },
      '00200011': { vr: 'IS', Value: [1] },
      '00200013': { vr: 'IS', Value: [i + 1] },
      '00200032': { vr: 'DS', Value: [0, 0, i * 2] },
      '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] },
      '00200052': { vr: 'UI', Value: [frame] },
      '00280002': { vr: 'US', Value: [1] },
      '00280004': { vr: 'CS', Value: ['MONOCHROME2'] },
      '00280010': { vr: 'US', Value: [32] },
      '00280011': { vr: 'US', Value: [32] },
      '00280030': { vr: 'DS', Value: [1, 1] },
      '00280100': { vr: 'US', Value: [16] },
      '00280101': { vr: 'US', Value: [16] },
      '00280102': { vr: 'US', Value: [15] },
      '00280103': { vr: 'US', Value: [0] },
      '00281050': { vr: 'DS', Value: [40] },
      '00281051': { vr: 'DS', Value: [400] },
      '00281052': { vr: 'DS', Value: [-1024] },
      '00281053': { vr: 'DS', Value: [1] },
      '7FE00010': { vr: 'OW', Value: [pixels.buffer] },
    };
    return {
      name: `synthetic-${i + 1}.dcm`,
      mimeType: 'application/dicom',
      buffer: Buffer.from(dict.write()),
    };
  });
  return { study, series, files };
}
