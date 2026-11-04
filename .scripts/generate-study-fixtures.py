#!/usr/bin/env python3
"""生成两份明确标识的合成CT Study容量夹具，不含真实患者数据。"""
import argparse
import os
import array
import math
from pathlib import Path
import struct
import uuid
import zipfile

ROOT = Path(os.environ.get('COLLA_CAPACITY_FIXTURES', '/Users/itboybob/Project/colla_tool/data'))
CLASS = '1.2.840.10008.5.1.4.1.1.2'

def uid(label):
    return '2.25.' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'colla-capacity/' + label).int)

def tag(group, element, vr, value):
    if vr == 'US': value = struct.pack('<H', value)
    elif vr == 'UL': value = struct.pack('<I', value)
    elif not isinstance(value, bytes): value = str(value).encode('ascii')
    if len(value) % 2: value += b'\0' if vr in ('UI', 'OB', 'OW') else b' '
    prefix = struct.pack('<HH', group, element) + vr.encode('ascii')
    return prefix + (b'\0\0' + struct.pack('<I', len(value)) if vr in ('OB','OW','SQ','UN','UT') else struct.pack('<H', len(value))) + value

def dicom(count, index, pixels):
    sop, study, series, frame = [uid(f'{count}/{x}') for x in (f'instance/{index}', 'study', 'series', 'frame')]
    meta = b''.join([tag(2,1,'OB',b'\0\1'),tag(2,2,'UI',CLASS),tag(2,3,'UI',sop),tag(2,0x10,'UI','1.2.840.10008.1.2.1'),tag(2,0x12,'UI',uid('implementation'))])
    fields = [(8,8,'CS','DERIVED\\SECONDARY\\AXIAL'),(8,0x16,'UI',CLASS),(8,0x18,'UI',sop),(8,0x20,'DA','20261104'),(8,0x30,'TM','120000'),(8,0x60,'CS','CT'),(8,0x1030,'LO','SYNTHETIC CAPACITY TEST - NOT PATIENT DATA'),(8,0x103e,'LO','Synthetic CT'),(0x10,0x10,'PN','SYNTHETIC^CAPACITY'),(0x10,0x20,'LO',f'SYNTHETIC-{count}'),(0x18,0x50,'DS','1'),(0x18,0x88,'DS','1'),(0x20,0xd,'UI',study),(0x20,0xe,'UI',series),(0x20,0x11,'IS','1'),(0x20,0x13,'IS',str(index+1)),(0x20,0x32,'DS',f'0\\0\\{index}'),(0x20,0x37,'DS','1\\0\\0\\0\\1\\0'),(0x20,0x52,'UI',frame),(0x28,2,'US',1),(0x28,4,'CS','MONOCHROME2'),(0x28,0x10,'US',512),(0x28,0x11,'US',512),(0x28,0x30,'DS','0.7\\0.7'),(0x28,0x100,'US',16),(0x28,0x101,'US',16),(0x28,0x102,'US',15),(0x28,0x103,'US',0),(0x28,0x1050,'DS','40'),(0x28,0x1051,'DS','400'),(0x28,0x1052,'DS','-1024'),(0x28,0x1053,'DS','1'),(0x7fe0,0x10,'OW',pixels)]
    return bytes(128)+b'DICM'+tag(2,0,'UL',len(meta))+meta+b''.join(tag(*f) for f in fields)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,default=ROOT)
    root=parser.parse_args().output_dir
    root.mkdir(parents=True, exist_ok=True)
    templates = []
    for k in range(8):
        pixels = array.array('H', (1124 + ((x+y+k)%32) if math.hypot(x-256,y-256)<170-k*3 else 24 for y in range(512) for x in range(512)))
        import sys
        if sys.byteorder != 'little': pixels.byteswap()
        templates.append(pixels.tobytes())
    for count in (200, 800):
        target=root/f'synthetic-ct-study-{count}.zip'
        with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_STORED) as archive:
            for i in range(count): archive.writestr(f'study-{count}/synthetic-{i+1:04d}.dcm',dicom(count,i,templates[i%8]))
            archive.writestr('说明.txt',f'合成CT容量夹具，不含真实患者信息，不是TCIA原始影像。一个Study，{count}个512×512、16位单帧DICOM实例。\n生成脚本：.scripts/generate-study-fixtures.py\n原始像素约{count/2:.0f}MiB；ZIP不压缩以保留真实传输量。\n')
        print(f'{target}: {target.stat().st_size/1024/1024:.2f} MiB, {count} DICOM文件')
if __name__ == '__main__': main()
