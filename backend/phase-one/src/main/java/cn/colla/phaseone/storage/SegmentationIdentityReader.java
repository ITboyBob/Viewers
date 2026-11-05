package cn.colla.phaseone.storage;

import cn.colla.phaseone.shared.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.springframework.stereotype.Component;

/** 身份来自实际不可变原图和已确认成果；文件对象 ID、修订号及客户端操作声明不参与判断。 */
@Component
public class SegmentationIdentityReader {
  private static final Set<String> SUPPORTED =
      Set.of(
          "1.2.840.10008.5.1.4.1.1.66.4",
          "1.2.840.10008.5.1.4.1.1.66.7",
          "1.2.840.10008.5.1.4.1.1.481.3");

  public Set<String> source(Path path) {
    try (var input = new DicomInputStream(path.toFile())) {
      input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
      // 只读取 SOP / Study / Series 身份所在的前段元数据，不读取轮廓或像素。
      var data = input.readDataset(-1, Tag.SeriesNumber);
      if (!SUPPORTED.contains(data.getString(Tag.SOPClassUID, ""))) return Set.of();
      String study = data.getString(Tag.StudyInstanceUID),
          series = data.getString(Tag.SeriesInstanceUID),
          sop = data.getString(Tag.SOPInstanceUID);
      if (!uid(study) || !uid(series) || !uid(sop)) throw ApiException.validation();
      return Set.of("dicom:" + study + "/" + series + "/" + sop);
    } catch (IOException invalid) {
      // 旧导入契约允许非 DICOM 的测试材料；这类材料绝不贡献可信分割基线。
      // 真正损坏的分割不能因此被声明为已有实体，后续提交仍须通过基线校验。
      return Set.of();
    }
  }

  private boolean uid(String value) {
    return value != null && value.length() <= 64 && value.matches("[0-9]+(?:\\.[0-9]+)*");
  }

  public Set<String> packet(JsonNode state) {
    var result = new HashSet<String>();
    for (var item : state.path("segmentations")) {
      if (!item.isObject() || !text(item.path("segmentationId"))) throw ApiException.validation();
      var identity = item.has("entity_id") ? item.path("entity_id") : item.path("segmentationId");
      if (!text(identity) || !result.add(identity.textValue())) throw ApiException.validation();
    }
    return result;
  }

  private boolean text(JsonNode value) {
    return value.isTextual() && !value.textValue().isBlank() && value.textValue().length() <= 1024;
  }
}
