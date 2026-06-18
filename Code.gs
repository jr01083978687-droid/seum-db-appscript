/************************************************************
 * SEUM DB V1 통합코드
 * 목적: 네이버 블로그 체험단 흔적 → 네이버 지역검색 매칭 → 최종DB_창고 저장
 * 주의: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET은 Apps Script [프로젝트 설정] > [스크립트 속성]에 저장
 ************************************************************/

const SEUM_BLOG_API_URL = "https://openapi.naver.com/v1/search/blog.json";
const SEUM_LOCAL_API_URL = "https://openapi.naver.com/v1/search/local.json";

const SEUM_FINAL_SHEET = "최종DB_창고";
const WAREHOUSE_FINAL_SHEET = SEUM_FINAL_SHEET; // 기존 함수 호환용

const SEUM_RAW_SHEET = "원본수집";
const SEUM_MATCH_SHEET = "네이버매칭";
const SEUM_HOLD_SHEET = "보류DB";
const SEUM_ZERO_SHEET = "0컨택리스트";
const SEUM_LOG_SHEET = "수집로그";

const SEUM_TARGET_AREA_WORDS = ["서울", "경기", "인천"];

const SEUM_REGIONS = [
  "강남", "논현", "역삼", "삼성", "선릉", "청담", "압구정", "신사",
  "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포", "공덕",
  "송파", "잠실", "석촌", "문정", "건대", "왕십리", "여의도", "용산",
  "수원", "분당", "판교", "성남", "일산", "부천", "안양", "하남", "남양주",
  "용인", "광교", "동탄", "평택", "화성", "김포", "파주", "의정부", "구리", "광명",
  "시흥", "안산", "군포", "의왕", "과천",
  "인천", "송도", "청라", "부평", "구월동"
];

const SEUM_FOOD_WORDS = ["맛집", "술집", "고기집", "카페"];

/***********************
 * 0. 최초 설치 / 점검
 ***********************/

function SEUM_V1_0_installSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheetWithHeadersKeepData_(ss, SEUM_RAW_SHEET, [
    "수집일시", "출처", "검색어", "블로그제목", "블로그요약",
    "블로그링크", "작성일", "검색지역", "매칭검색어", "업체명후보"
  ]);

  ensureSheetWithHeadersKeepData_(ss, SEUM_MATCH_SHEET, [
    "수집일시", "검색어", "네이버업체명", "주소", "도로명주소",
    "카테고리", "네이버링크", "매칭상태", "판단사유"
  ]);

  ensureSheetWithHeadersKeepData_(ss, SEUM_HOLD_SHEET, [
    "수집일시", "보류사유", "검색어", "블로그제목", "업체명후보",
    "매칭검색어", "네이버업체명", "주소", "카테고리", "근거링크"
  ]);

  ensureSheetWithHeadersKeepData_(ss, SEUM_FINAL_SHEET, [
    "수집일시", "DB키", "DB등급", "점수", "0컨택여부",
    "업체명", "주소", "도로명주소", "카테고리", "지역",
    "출처", "검색어", "근거링크", "추천멘트", "상태",
    "최초수집일", "메모"
  ]);

  ensureSheetWithHeadersKeepData_(ss, SEUM_ZERO_SHEET, [
    "입력일", "박싱만료일", "담당자", "업체명", "주소",
    "대표010", "출처", "상태", "메모"
  ]);

  ensureSheetWithHeadersKeepData_(ss, SEUM_LOG_SHEET, [
    "실행일시", "실행함수", "검색어수", "블로그후보수",
    "매칭성공수", "최종저장수", "보류수", "메모"
  ]);

  SEUM_V1_removeRecentReviewColumns();

  SpreadsheetApp.getUi().alert("SEUM DB V1 시트 점검 완료\n\n최종 저장 위치: 최종DB_창고\n기존 데이터는 삭제하지 않았습니다.");
}

function ensureSheetWithHeadersKeepData_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function SEUM_V1_removeRecentReviewColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  if (!sheet) return;

  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const removeHeaders = ["최근블로그리뷰일자", "최근리뷰경과일", "신규성판단"];
  const deleteCols = [];

  headers.forEach((header, index) => {
    if (removeHeaders.includes(String(header).trim())) deleteCols.push(index + 1);
  });

  deleteCols.sort((a, b) => b - a).forEach(col => sheet.deleteColumn(col));
}

function SEUM_V1_1_testNaverApi() {
  const data = searchNaverBlog_("강남 맛집 식사권을 제공받아", 1);
  SpreadsheetApp.getUi().alert("네이버 API 테스트 완료\n결과 개수: " + data.length);
}

function SEUM_V1_2_clearWorkingOnly() {
  clearRowsExceptHeader_(SEUM_RAW_SHEET);
  clearRowsExceptHeader_(SEUM_MATCH_SHEET);
  clearRowsExceptHeader_(SEUM_HOLD_SHEET);

  SpreadsheetApp.getUi().alert("작업시트 초기화 완료\n\n원본수집 / 네이버매칭 / 보류DB만 비웠습니다.\n최종DB_창고와 0컨택리스트는 유지됩니다.");
}

function clearRowsExceptHeader_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
}

/***********************
 * 1. 수집 실행 함수
 * 한 번에 하나씩 실행 권장
 ***********************/

function SEUM_V1_collect_1_SeoulCore() {
  collectByRegionFoodTrace_("SEUM_V1_collect_1_SeoulCore",
    ["강남", "성수", "홍대", "신촌", "마포"],
    ["맛집", "술집", "고기집"],
    ["업체로부터 식사권을 제공받아", "식사권을 제공받아", "강남맛집을 통해"],
    3
  );
}

function SEUM_V1_collect_2_SeoulMore() {
  collectByRegionFoodTrace_("SEUM_V1_collect_2_SeoulMore",
    ["송파", "잠실", "합정", "건대", "왕십리"],
    ["맛집", "술집", "고기집"],
    ["업체로부터 식사권을 제공받아", "식사권을 제공받아", "디너의여왕을 통해"],
    3
  );
}

function SEUM_V1_collect_3_GyeonggiCore() {
  collectByRegionFoodTrace_("SEUM_V1_collect_3_GyeonggiCore",
    ["수원", "분당", "판교", "일산", "부천", "안양", "하남", "남양주"],
    ["맛집", "술집", "고기집"],
    ["업체로부터 식사권을 제공받아", "식사권을 제공받아", "체험 후 솔직하게 작성"],
    3
  );
}

function SEUM_V1_collect_4_Incheon() {
  collectByRegionFoodTrace_("SEUM_V1_collect_4_Incheon",
    ["인천", "송도"],
    ["맛집", "술집", "고기집", "카페"],
    ["업체로부터 식사권을 제공받아", "식사권을 제공받아", "체험 후 솔직하게 작성", "디너의여왕을 통해"],
    4
  );
}

function SEUM_V1_collect_5_PlatformCore() {
  const queries = [];
  const regions = ["강남", "논현", "역삼", "선릉", "성수", "홍대", "연남", "신촌", "송파", "잠실", "수원", "분당", "판교", "인천", "송도"];
  const foods = ["맛집", "술집", "고기집"];
  const traces = ["강남맛집을 통해", "디너의여왕을 통해"];

  regions.forEach(region => foods.forEach(food => traces.forEach(trace => queries.push(`${region} ${food} ${trace}`))));
  collectSeumWarehouseByQueries_("SEUM_V1_collect_5_PlatformCore", queries, 3);
}

function SEUM_V1_collect_6_ReviewPlatforms() {
  const queries = [];
  const regions = ["강남", "성수", "홍대", "신촌", "마포", "송파", "잠실", "수원", "분당", "인천", "송도"];
  const foods = ["맛집", "술집", "고기집"];
  const platforms = ["리뷰노트", "레뷰", "미블", "서울오빠"];

  regions.forEach(region => foods.forEach(food => platforms.forEach(platform => queries.push(`${region} ${food} ${platform} 식사권`))));
  collectSeumWarehouseByQueries_("SEUM_V1_collect_6_ReviewPlatforms", queries, 3);
}

function SEUM_V1_collect_7_GeneralProvidedTerms() {
  const queries = [];
  const regions = ["논현", "역삼", "삼성", "청담", "압구정", "연남", "상수", "합정", "공덕", "여의도", "석촌", "문정", "광교", "광명", "구리", "구월동", "부평"];
  const foods = ["맛집", "술집", "고기집"];
  const traces = ["식사권을 제공받아", "서비스를 제공받아 작성"];

  regions.forEach(region => foods.forEach(food => traces.forEach(trace => queries.push(`${region} ${food} ${trace}`))));
  collectSeumWarehouseByQueries_("SEUM_V1_collect_7_GeneralProvidedTerms", queries, 3);
}

function SEUM_V1_collect_8_MoreGyeonggi() {
  const queries = [];
  const regions = ["용인", "광교", "동탄", "평택", "화성", "김포", "파주", "의정부", "구리", "광명", "시흥", "안산", "군포", "의왕", "과천"];
  const foods = ["맛집", "술집", "고기집"];
  const traces = ["식사권을 제공받아", "체험 후 솔직하게 작성"];

  regions.forEach(region => foods.forEach(food => traces.forEach(trace => queries.push(`${region} ${food} ${trace}`))));
  collectSeumWarehouseByQueries_("SEUM_V1_collect_8_MoreGyeonggi", queries, 3);
}

function SEUM_V1_collect_TestSmall() {
  collectSeumWarehouseByQueries_("SEUM_V1_collect_TestSmall", [
    "신촌 맛집 업체로부터 식사권을 제공받아",
    "송도 맛집 업체로부터 식사권을 제공받아",
    "강남 맛집 식사권을 제공받아",
    "홍대 술집 식사권을 제공받아",
    "성수 맛집 체험 후 솔직하게 작성"
  ], 5);
}

function collectByRegionFoodTrace_(runName, regions, foods, traces, displayCount) {
  const queries = [];
  regions.forEach(region => foods.forEach(food => traces.forEach(trace => queries.push(`${region} ${food} ${trace}`))));
  collectSeumWarehouseByQueries_(runName, queries, displayCount);
}

function collectSeumWarehouseByQueries_(runName, queries, displayCount) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rawSheet = ss.getSheetByName(SEUM_RAW_SHEET);
  const matchSheet = ss.getSheetByName(SEUM_MATCH_SHEET);
  const holdSheet = ss.getSheetByName(SEUM_HOLD_SHEET);
  const finalSheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  const zeroSheet = ss.getSheetByName(SEUM_ZERO_SHEET);
  const logSheet = ss.getSheetByName(SEUM_LOG_SHEET);

  if (!rawSheet || !matchSheet || !holdSheet || !finalSheet || !zeroSheet || !logSheet) {
    throw new Error("먼저 SEUM_V1_0_installSheets 함수를 실행해 주세요.");
  }

  const existingKeys = getExistingDbKeys_(finalSheet);
  const zeroRows = getZeroContactRows_(zeroSheet);
  const now = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");

  const rawRows = [];
  const matchRows = [];
  const holdRows = [];
  const finalRows = [];

  let blogCount = 0;
  let matchedCount = 0;
  let savedCount = 0;
  let holdCount = 0;

  queries.forEach(query => {
    const searchRegion = extractRegionFromQuery_(query);
    let blogItems = [];

    try {
      blogItems = searchNaverBlog_(query, displayCount);
    } catch (e) {
      holdRows.push([now, "블로그API실패: " + e.message, query, "", "", "", "", "", "", ""]);
      holdCount++;
      return;
    }

    Utilities.sleep(120);

    blogItems.forEach(item => {
      blogCount++;

      const title = cleanText_(item.title || "");
      const description = cleanText_(item.description || "");
      const link = item.link || "";
      const postdate = item.postdate || "";

      const localInfo = makeLocalQueryInfo_(searchRegion, title, description);
      const localQuery = localInfo.query;
      const storeCandidate = localInfo.storeCandidate;

      rawRows.push([now, "네이버블로그_체험단흔적", query, title, description, link, postdate, searchRegion, localQuery, storeCandidate]);

      if (!localInfo.ok) {
        holdRows.push([now, localInfo.reason, query, title, storeCandidate, localQuery, "", "", "", link]);
        holdCount++;
        return;
      }

      let localItems = [];
      try {
        localItems = searchNaverLocal_(localQuery, 3);
      } catch (e) {
        holdRows.push([now, "지역검색API실패: " + e.message, query, title, storeCandidate, localQuery, "", "", "", link]);
        holdCount++;
        return;
      }

      Utilities.sleep(120);

      if (!localItems || localItems.length === 0) {
        matchRows.push([now, localQuery, "", "", "", "", "", "매칭실패", "지역검색 결과 없음"]);
        holdRows.push([now, "매칭실패", query, title, storeCandidate, localQuery, "", "", "", link]);
        holdCount++;
        return;
      }

      let savedThisBlog = false;
      let hadAnyQualityOk = false;

      for (let i = 0; i < localItems.length; i++) {
        const local = localItems[i];
        const localName = cleanText_(local.title || "");
        const address = cleanText_(local.address || "");
        const roadAddress = cleanText_(local.roadAddress || "");
        const category = cleanText_(local.category || "");
        const naverLink = local.link || "";
        const realAddress = roadAddress || address;
        const actualRegion = extractRegionFromAddress_(realAddress);

        const quality = judgeLocalMatchQuality_(localName, realAddress, category, title, description, storeCandidate);

        matchRows.push([now, localQuery, localName, address, roadAddress, category, naverLink, quality.ok ? "매칭성공" : "보류", quality.reason]);

        if (!quality.ok) continue;

        hadAnyQualityOk = true;
        matchedCount++;

        const dbKey = makeDbKey_(localName, realAddress);
        if (existingKeys[dbKey]) {
          savedThisBlog = true;
          break;
        }

        const zeroStatus = isZeroContacted_(localName, realAddress, zeroRows) ? "0컨택중" : "전화가능";
        const scoreData = scoreDb_(query, postdate, realAddress, category, zeroStatus);

        if (scoreData.grade === "C" && zeroStatus !== "0컨택중") {
          holdRows.push([now, "점수부족_C등급", query, title, storeCandidate, localQuery, localName, realAddress, category, link]);
          holdCount++;
          continue;
        }

        finalRows.push([
          now,
          dbKey,
          scoreData.grade,
          scoreData.score,
          zeroStatus,
          localName,
          address,
          roadAddress,
          category,
          actualRegion,
          "네이버블로그_체험단흔적",
          query,
          link,
          makeSalesMent_(query, zeroStatus),
          zeroStatus === "0컨택중" ? "전화금지" : "미컨택",
          now,
          ""
        ]);

        existingKeys[dbKey] = true;
        savedCount++;
        savedThisBlog = true;
        break;
      }

      if (!savedThisBlog) {
        holdRows.push([now, hadAnyQualityOk ? "중복또는점수부족으로_최종저장없음" : "최종저장없음_블로그제목과_업체명불일치가능", query, title, storeCandidate, localQuery, "", "", "", link]);
        holdCount++;
      }
    });
  });

  if (rawRows.length > 0) rawSheet.getRange(rawSheet.getLastRow() + 1, 1, rawRows.length, rawRows[0].length).setValues(rawRows);
  if (matchRows.length > 0) matchSheet.getRange(matchSheet.getLastRow() + 1, 1, matchRows.length, matchRows[0].length).setValues(matchRows);
  if (holdRows.length > 0) holdSheet.getRange(holdSheet.getLastRow() + 1, 1, holdRows.length, holdRows[0].length).setValues(holdRows);
  if (finalRows.length > 0) finalSheet.getRange(finalSheet.getLastRow() + 1, 1, finalRows.length, finalRows[0].length).setValues(finalRows);

  logSheet.appendRow([now, runName, queries.length, blogCount, matchedCount, savedCount, holdCount, "SEUM DB V1 실행 / 저장대상: 최종DB_창고"]);

  SpreadsheetApp.getUi().alert(
    "수집 완료!\n\n" +
    "실행함수: " + runName + "\n" +
    "검색어 수: " + queries.length + "개\n" +
    "블로그 후보: " + blogCount + "개\n" +
    "매칭 성공: " + matchedCount + "개\n" +
    "최종DB_창고 신규 저장: " + savedCount + "개\n" +
    "보류DB: " + holdCount + "개"
  );
}

/***********************
 * 2. 정리 함수
 ***********************/

function SEUM_V1_3_cleanAll() {
  const a = cleanMismatchRowsByRawStrict_();
  const b = cleanDuplicateEvidenceLinks_();
  const c = cleanCurrentBatchQualityIssues_();

  SpreadsheetApp.getUi().alert(
    "SEUM V1 정리 완료\n\n" +
    "오매칭 정리: " + a + "건\n" +
    "근거링크 중복 정리: " + b + "건\n" +
    "품질 정리: " + c + "건\n\n" +
    "다음: SEUM_V1_4_checkStatus 실행"
  );
}

function cleanMismatchRowsByRawStrict_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  const rawSheet = ss.getSheetByName(SEUM_RAW_SHEET);
  if (!finalSheet || !rawSheet) return 0;

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();
  if (finalLastRow < 2 || rawLastRow < 2) return 0;

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const finalNameCol = finalHeaders.indexOf("업체명");
  const finalLinkCol = finalHeaders.indexOf("근거링크");
  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (finalNameCol < 0 || finalLinkCol < 0 || rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0) return 0;

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;
    rawMap[link] = {
      title: String(row[rawTitleCol] || ""),
      description: String(row[rawDescCol] || ""),
      candidate: rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : ""
    };
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();
  const deleteRows = [];

  finalValues.forEach((row, index) => {
    const localName = String(row[finalNameCol] || "").trim();
    const link = String(row[finalLinkCol] || "").trim();
    if (!link || !rawMap[link]) return;

    const raw = rawMap[link];
    if (!isLikelySameStoreStrict_(localName, raw.title, raw.description, raw.candidate)) {
      deleteRows.push(index + 2);
    }
  });

  Array.from(new Set(deleteRows)).sort((a, b) => b - a).forEach(rowNum => finalSheet.deleteRow(rowNum));
  return deleteRows.length;
}

function cleanDuplicateEvidenceLinks_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  const rawSheet = ss.getSheetByName(SEUM_RAW_SHEET);
  if (!finalSheet || !rawSheet) return 0;

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();
  if (finalLastRow < 2 || rawLastRow < 2) return 0;

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const addrCol = finalHeaders.indexOf("주소");
  const roadAddrCol = finalHeaders.indexOf("도로명주소");
  const regionCol = finalHeaders.indexOf("지역");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");

  if (nameCol < 0 || addrCol < 0 || roadAddrCol < 0 || regionCol < 0 || linkCol < 0 || rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0) return 0;

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;
    if (!rawMap[link]) rawMap[link] = "";
    rawMap[link] += " " + String(row[rawTitleCol] || "") + " " + String(row[rawDescCol] || "");
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();
  const linkGroups = {};

  finalValues.forEach((row, idx) => {
    const link = String(row[linkCol] || "").trim();
    if (!link) return;
    if (!linkGroups[link]) linkGroups[link] = [];
    linkGroups[link].push({ rowNumber: idx + 2, row });
  });

  let deleteRows = [];

  Object.keys(linkGroups).forEach(link => {
    const group = linkGroups[link];
    if (group.length <= 1) return;

    const rawText = rawMap[link] || "";
    if (!rawText) return; // 현재 원본수집에 없는 과거 링크는 안전하게 건드리지 않음

    let bestItem = null;
    let bestScore = -9999;

    group.forEach(item => {
      const row = item.row;
      const score = calcEvidenceMatchScore_(
        String(row[nameCol] || ""),
        String(row[addrCol] || ""),
        String(row[roadAddrCol] || ""),
        String(row[regionCol] || ""),
        rawText
      );

      if (score > bestScore) {
        bestScore = score;
        bestItem = item;
      }
    });

    group.forEach(item => {
      if (!bestItem || item.rowNumber !== bestItem.rowNumber) deleteRows.push(item.rowNumber);
    });
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);
  deleteRows.forEach(rowNum => finalSheet.deleteRow(rowNum));
  return deleteRows.length;
}

function cleanCurrentBatchQualityIssues_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  const rawSheet = ss.getSheetByName(SEUM_RAW_SHEET);
  if (!finalSheet || !rawSheet) return 0;

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();
  if (finalLastRow < 2 || rawLastRow < 2) return 0;

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const categoryCol = finalHeaders.indexOf("카테고리");
  const linkCol = finalHeaders.indexOf("근거링크");
  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (nameCol < 0 || categoryCol < 0 || linkCol < 0 || rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0) return 0;

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";
    rawMap[link] = String(row[rawTitleCol] || "") + " " + String(row[rawDescCol] || "") + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();
  const deleteRows = [];

  finalValues.forEach((row, index) => {
    const name = String(row[nameCol] || "").trim();
    const category = String(row[categoryCol] || "").trim();
    const link = String(row[linkCol] || "").trim();
    const rawText = rawMap[link] || "";

    if (isBadBusinessNameOrCategory_(name, category)) {
      deleteRows.push(index + 2);
      return;
    }

    if (rawText && !hasStrongStoreNameMatch_(name, rawText)) {
      deleteRows.push(index + 2);
    }
  });

  Array.from(new Set(deleteRows)).sort((a, b) => b - a).forEach(rowNum => finalSheet.deleteRow(rowNum));
  return deleteRows.length;
}

/***********************
 * 3. 상태 확인
 ***********************/

function SEUM_V1_4_checkStatus() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SEUM_FINAL_SHEET);
  const holdSheet = ss.getSheetByName(SEUM_HOLD_SHEET);
  const rawSheet = ss.getSheetByName(SEUM_RAW_SHEET);
  const logSheet = ss.getSheetByName(SEUM_LOG_SHEET);

  if (!sheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 시트를 찾을 수 없습니다.");
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const total = Math.max(0, lastRow - 1);

  if (total === 0) {
    SpreadsheetApp.getUi().alert("최종DB_창고에 DB가 없습니다.");
    return;
  }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const values = sheet.getRange(2, 1, total, lastCol).getValues();

  const gradeCol = headers.indexOf("DB등급");
  const callCol = headers.indexOf("0컨택여부");
  const statusCol = headers.indexOf("상태");
  const linkCol = headers.indexOf("근거링크");

  const gradeCount = {};
  const callCount = {};
  const statusCount = {};
  const linkCount = {};
  let duplicateLinks = 0;

  values.forEach(row => {
    const grade = gradeCol >= 0 ? String(row[gradeCol] || "") : "";
    const call = callCol >= 0 ? String(row[callCol] || "") : "";
    const status = statusCol >= 0 ? String(row[statusCol] || "") : "";
    const link = linkCol >= 0 ? String(row[linkCol] || "") : "";

    if (grade) gradeCount[grade] = (gradeCount[grade] || 0) + 1;
    if (call) callCount[call] = (callCount[call] || 0) + 1;
    if (status) statusCount[status] = (statusCount[status] || 0) + 1;
    if (link) linkCount[link] = (linkCount[link] || 0) + 1;
  });

  Object.keys(linkCount).forEach(link => {
    if (linkCount[link] > 1) duplicateLinks++;
  });

  const rawCount = rawSheet ? Math.max(0, rawSheet.getLastRow() - 1) : 0;
  const holdCount = holdSheet ? Math.max(0, holdSheet.getLastRow() - 1) : 0;
  const logCount = logSheet ? Math.max(0, logSheet.getLastRow() - 1) : 0;

  SpreadsheetApp.getUi().alert(
    "SEUM DB V1 상태\n\n" +
    "최종DB_창고 총 DB: " + total + "건\n" +
    "원본수집 현재: " + rawCount + "건\n" +
    "보류DB 현재: " + holdCount + "건\n" +
    "수집로그: " + logCount + "건\n" +
    "근거링크 중복 그룹: " + duplicateLinks + "개\n\n" +
    "등급: " + JSON.stringify(gradeCount) + "\n" +
    "0컨택여부: " + JSON.stringify(callCount) + "\n" +
    "상태: " + JSON.stringify(statusCount)
  );
}

/***********************
 * 4. 네이버 API
 ***********************/

function searchNaverBlog_(query, display) {
  const data = naverGet_(SEUM_BLOG_API_URL, { query, display, sort: "date" });
  return data.items || [];
}

function searchNaverLocal_(query, display) {
  const data = naverGet_(SEUM_LOCAL_API_URL, { query, display, sort: "random" });
  return data.items || [];
}

function naverGet_(url, params) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty("NAVER_CLIENT_ID");
  const clientSecret = props.getProperty("NAVER_CLIENT_SECRET");

  if (!clientId || !clientSecret) throw new Error("NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 스크립트 속성에 없습니다.");

  const queryString = Object.keys(params).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join("&");
  const response = UrlFetchApp.fetch(`${url}?${queryString}`, {
    method: "get",
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) throw new Error(`네이버 API 오류 ${code}: ${text}`);
  return JSON.parse(text);
}

/***********************
 * 5. 매칭/필터 로직
 ***********************/

function makeLocalQueryInfo_(searchRegion, title, description) {
  const titleClean = cleanText_(title || "");
  const descClean = cleanText_(description || "");
  const textForLocation = titleClean + " " + descClean;
  const loc = extractLocationHint_(textForLocation) || searchRegion;

  let working = titleClean;
  working = working.replace(/\[[^\]]+\]/g, " ");
  working = working.replace(/\([^\)]*\)/g, " ");

  const foodCut = findFirstFoodKeywordIndex_(working);
  if (foodCut.index >= 0) working = working.substring(foodCut.index + foodCut.keyword.length);

  working = removeBadWordsForLocalSearch_(working, loc);

  let tokens = extractCandidateTokens_(working, loc);

  if (tokens.length === 0) {
    const hashCandidate = extractHashTagCandidate_(descClean);
    if (hashCandidate) tokens = [hashCandidate];
  }

  if (tokens.length === 0) tokens = extractCandidateTokens_(titleClean, loc);

  if (tokens.length === 0) {
    return { ok: false, reason: "업체명후보추출실패", query: `${loc} 맛집`, storeCandidate: "" };
  }

  let candidateTokens = tokens.slice(0, 2);
  if (candidateTokens.length >= 2 && candidateTokens[1].length >= 7) candidateTokens = candidateTokens.slice(0, 1);

  const storeCandidate = candidateTokens.join(" ").trim();

  if (isBadStoreCandidate_(storeCandidate) || isGenericBusinessOrLocationCandidate_(storeCandidate)) {
    return { ok: false, reason: "업체명후보가_지역명또는일반어", query: `${loc} ${storeCandidate}`.trim(), storeCandidate };
  }

  const localQuery = `${loc} ${storeCandidate}`.trim();
  if (localQuery.length < 4) {
    return { ok: false, reason: "매칭검색어_너무짧음", query: localQuery, storeCandidate };
  }

  return { ok: true, reason: "", query: localQuery, storeCandidate };
}

function judgeLocalMatchQuality_(localName, address, category, title, description, storeCandidate) {
  if (isHardExcludedName_(localName)) return { ok: false, reason: "업체명_비음식점제외" };
  if (isAnimalCafeOrNonFoodCafe_(localName, category)) return { ok: false, reason: "동물카페_비음식카페제외" };
  if (isBadBusinessNameOrCategory_(localName, category)) return { ok: false, reason: "비음식업태제외" };
  if (!isTargetArea_(address)) return { ok: false, reason: "수도권아님" };
  if (!isFoodCategory_(category)) return { ok: false, reason: "음식점카테고리아님" };
  if (!isLikelySameStoreStrict_(localName, title, description, storeCandidate)) return { ok: false, reason: "블로그제목과_네이버업체명_불일치" };
  return { ok: true, reason: "정상" };
}

function isTargetArea_(address) {
  if (!address) return false;
  return SEUM_TARGET_AREA_WORDS.some(word => address.includes(word));
}

function isFoodCategory_(category) {
  if (!category) return false;
  const text = String(category);
  if (isHardExcludedCategory_(text)) return false;

  const foodWords = [
    "음식점", "한식", "중식", "중식당", "일식", "일식당", "양식",
    "이탈리아음식", "프랑스음식", "아시아음식", "태국음식", "베트남음식", "멕시코음식",
    "카페", "카페,디저트", "디저트", "베이커리", "브런치",
    "술집", "요리주점", "이자카야", "포장마차", "호프", "맥주", "바(BAR)", "바",
    "육류", "고기요리", "돼지고기구이", "소고기구이", "닭갈비", "곱창", "막창",
    "양꼬치", "양갈비", "양대창", "대창", "족발", "보쌈", "치킨", "피자", "햄버거",
    "분식", "김밥", "국밥", "국수", "냉면", "칼국수", "만두", "샤브샤브",
    "돈가스", "돈카츠", "초밥", "스시", "참치", "생선회", "횟집", "회센터",
    "장어", "아귀찜", "아구찜", "조개", "해물", "감자탕", "해장국", "곰탕", "순대",
    "라멘", "우동", "텐동", "오마카세", "샐러드", "다이어트"
  ];

  return foodWords.some(word => text.includes(word));
}

function isHardExcludedCategory_(category) {
  const text = String(category || "");
  const hardExcludeWords = [
    "어학교육", "영어회화", "어학원", "교육", "학원", "스터디카페", "공유오피스",
    "장소대여", "파티룸", "공방", "클래스", "체험관", "전시장", "렌탈", "대관",
    "병원", "의원", "피부", "미용", "네일", "마사지", "헬스", "필라테스", "요가",
    "부동산", "숙박", "호텔", "펜션", "키즈카페", "PC방", "노래방", "노래타운",
    "건강", "의료", "요양원", "요양센터", "재활", "복지", "노인복지"
  ];
  return hardExcludeWords.some(word => text.includes(word));
}

function isHardExcludedName_(name) {
  const text = String(name || "");
  const hardExcludeNames = [
    "컬컴", "영어회화", "스터디카페", "공유오피스", "공방", "필라테스", "요가", "피부", "네일",
    "요양원", "요양센터", "재활", "복지센터", "노래타운", "노래방"
  ];
  return hardExcludeNames.some(word => text.includes(word));
}

function isAnimalCafeOrNonFoodCafe_(name, category) {
  const text = String(name || "") + " " + String(category || "");
  const badWords = [
    "고양이카페", "애견카페", "강아지카페", "동물카페", "펫카페", "반려동물", "길고양이", "캣카페",
    "보드게임카페", "만화카페", "북카페", "키즈카페"
  ];
  return badWords.some(word => text.includes(word));
}

function isBadBusinessNameOrCategory_(name, category) {
  const text = String(name || "") + " " + String(category || "");
  const badWords = [
    "노래타운", "노래방", "룸술집", "키즈카페", "고양이카페", "애견카페", "동물카페", "펫카페",
    "스터디카페", "공유오피스", "장소대여", "파티룸", "어학교육", "영어회화", "요양원", "재활"
  ];
  return badWords.some(word => text.includes(word));
}

function isLikelySameStoreStrict_(localName, title, description, storeCandidate) {
  const nameClean = cleanText_(localName);
  const titleDesc = normalizeText_(title + " " + description);
  const localNameKey = normalizeText_(nameClean);
  const candidateKey = normalizeText_(storeCandidate);

  if (!localNameKey) return false;
  if (isGenericBusinessOrLocationCandidate_(storeCandidate)) return false;

  const tokens = getStoreNameTokens_(nameClean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length >= 3 && titleDesc.includes(token)) return true;
  }

  if (candidateKey.length >= 3 && localNameKey.includes(candidateKey) && titleDesc.includes(candidateKey)) return true;
  return false;
}

function hasStrongStoreNameMatch_(localName, rawText) {
  const raw = normalizeText_(rawText);
  const tokens = getStoreNameTokens_(localName);
  if (tokens.length === 0) return false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length >= 3 && raw.includes(token)) return true;
  }
  return false;
}

function getStoreNameTokens_(name) {
  return cleanText_(name)
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/점/g, " ")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(normalizeText_)
    .filter(token => token.length >= 3)
    .filter(token => !isGenericToken_(token))
    .filter(token => !isLocationToken_(token))
    .filter(token => !isGenericBusinessOrLocationToken_(token));
}

function extractCandidateTokens_(text, loc) {
  return String(text || "")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(word => word.length >= 2)
    .filter(word => !isGenericToken_(word))
    .filter(word => !isLocationToken_(word))
    .filter(word => !isGenericBusinessOrLocationToken_(word))
    .filter(word => !loc || normalizeText_(word) !== normalizeText_(loc));
}

function extractHashTagCandidate_(description) {
  const text = String(description || "");
  const matches = text.match(/#[가-힣a-zA-Z0-9_]+/g);
  if (!matches) return "";

  for (let i = 0; i < matches.length; i++) {
    const tag = matches[i].replace("#", "").trim();
    if (!tag || tag.length < 3) continue;
    if (isGenericBusinessOrLocationToken_(tag) || isLocationToken_(tag)) continue;

    const genericWords = ["맛집", "한정식맛집", "인천맛집", "서울맛집", "수원맛집", "구월동맛집", "송도맛집", "연수구한정식", "상견례추천", "돌잔치", "칠순잔치", "환갑잔치", "데이트", "회식"];
    let isGeneric = false;
    genericWords.forEach(word => { if (tag.includes(word)) isGeneric = true; });
    if (isGeneric) continue;

    return tag;
  }
  return "";
}

function findFirstFoodKeywordIndex_(text) {
  const keywords = ["맛집", "술집", "고기집", "카페"];
  let bestIndex = -1;
  let bestKeyword = "";

  keywords.forEach(keyword => {
    const index = text.indexOf(keyword);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestKeyword = keyword;
    }
  });

  return { index: bestIndex, keyword: bestKeyword };
}

function extractLocationHint_(text) {
  if (!text) return "";

  const bracketMatch = text.match(/\[([^\]]+)\]/);
  if (bracketMatch && bracketMatch[1]) {
    const inBracket = bracketMatch[1].trim();
    if (inBracket.length >= 2 && inBracket.length <= 12) return inBracket;
  }

  const locationHints = [
    "강남", "논현", "역삼", "삼성", "선릉", "압구정", "청담", "신사",
    "성수", "홍대", "연남", "합정", "상수", "마포", "공덕", "망원",
    "신촌", "이대", "잠실", "송파", "석촌", "문정", "건대", "왕십리", "용산", "종로", "을지로", "명동", "여의도",
    "수원", "호매실", "광교", "분당", "판교", "서현", "성남", "일산", "부천", "안양", "하남", "남양주", "의정부", "구리", "광명", "안산",
    "용인", "동탄", "평택", "화성", "김포", "파주", "운정", "시흥", "군포", "의왕", "과천",
    "인천", "송도", "연수구", "구월동", "부평", "청라"
  ];

  for (let i = 0; i < locationHints.length; i++) {
    if (text.includes(locationHints[i])) return locationHints[i];
  }
  return "";
}

function extractRegionFromQuery_(query) {
  for (let i = 0; i < SEUM_REGIONS.length; i++) {
    if (query.includes(SEUM_REGIONS[i])) return SEUM_REGIONS[i];
  }
  return "수도권";
}

function extractRegionFromAddress_(address) {
  if (!address) return "지역미확인";
  const parts = address.split(" ").filter(Boolean);
  if (address.includes("서울")) return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : "서울";
  if (address.includes("경기")) return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : "경기";
  if (address.includes("인천")) return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : "인천";
  return "수도권외";
}

function removeBadWordsForLocalSearch_(text, loc) {
  let result = text;
  const badWords = [
    "업체로부터", "식사권", "제공받아", "작성", "체험단", "방문", "소정의", "원고료", "협찬", "리뷰", "무료", "서비스",
    "맛집", "술집", "고기집", "카페", "후기", "추천", "블로그", "네이버", "포스팅", "직접", "솔직하게", "광고", "제공", "받아", "작성되었습니다",
    "가족", "모임", "회식", "데이트", "외식", "장소", "상견례", "돌잔치", "칠순잔치", "환갑잔치",
    "현대백화점", "백화점", "국내", "일본", "괜찮다는", "냉모밀", "안심카츠", "해물찜", "아구찜", "아귀찜", "돈카츠", "돈가스", "육회", "맥주", "소주", "안주",
    "가성비", "분위기", "핫플", "메뉴", "주차", "근처", "내돈내산", "솔직", "먹방", "맛있는", "존맛", "리얼", "야장", "대기공간", "넓어서",
    "엄마", "아빠", "친구", "본", "본포스팅", "작성한", "작성하였습니다"
  ];

  badWords.forEach(word => { result = result.split(word).join(" "); });

  if (loc) {
    const locParts = loc.split(" ");
    locParts.forEach(part => {
      if (part.length >= 2) {
        result = result.split(part).join(" ");
        result = result.split(part + "점").join(" ");
      }
    });
  }
  return result;
}

function isGenericToken_(word) {
  const normalized = normalizeText_(word);
  if (!normalized || normalized.length <= 1) return true;

  const bads = [
    "야장", "분위기", "추천", "근처", "가성비", "핫플", "대기공간", "넓어서", "좋은", "괜찮은", "맛있는", "최고", "궁합", "메뉴", "주차", "점심", "저녁",
    "데이트", "회식", "가족", "모임", "외식", "장소", "내돈내산", "솔직", "리얼", "먹방", "후기", "리뷰", "엄마", "아빠", "친구", "연인", "직장인",
    "방문", "오늘", "어제", "최근", "이번", "정말", "완전", "인기", "유명", "신상", "오픈", "소개", "정보", "블로그", "포스팅", "사진", "영상", "체험단",
    "업체로부터", "식사권", "제공받아", "서비스", "작성"
  ].map(normalizeText_);

  return bads.includes(normalized);
}

function isBadStoreCandidate_(candidate) {
  const cleaned = cleanText_(candidate);
  const normalized = normalizeText_(cleaned);
  if (!normalized || normalized.length < 2) return true;

  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return true;

  let allGeneric = true;
  parts.forEach(part => {
    if (!isGenericToken_(part) && !isLocationToken_(part) && !isGenericBusinessOrLocationToken_(part)) allGeneric = false;
  });
  if (allGeneric) return true;

  const badWholeWords = ["야장", "분위기", "추천", "근처", "가성비", "핫플", "대기공간", "점심", "저녁", "데이트", "회식", "엄마 아빠", "가족 모임", "메뉴 주차"].map(normalizeText_);
  return badWholeWords.includes(normalized);
}

function isGenericBusinessOrLocationCandidate_(candidate) {
  if (!candidate) return true;
  const parts = String(candidate).split(" ").map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return true;

  let allGeneric = true;
  parts.forEach(part => {
    if (!isGenericBusinessOrLocationToken_(part) && !isLocationToken_(part)) allGeneric = false;
  });
  return allGeneric;
}

function isGenericBusinessOrLocationToken_(word) {
  if (!word) return true;
  const text = String(word).trim();
  const normalized = normalizeText_(text);
  if (!normalized) return true;

  const endings = ["동", "구", "시", "군", "읍", "면", "리", "역", "길", "로"];
  if (endings.some(end => text.endsWith(end))) return true;

  const badWords = [
    "상견례", "상견례장소", "상견례장소로", "돌잔치", "칠순잔치", "환갑잔치", "회갑잔치", "가족모임", "가족모임장소", "모임장소", "회식장소", "데이트장소",
    "맛집추천", "한정식맛집", "고기집추천", "술집추천", "장소추천", "추천장소", "맛집", "술집", "고기집",
    "호매실", "금곡동", "영통", "광교", "서현", "분당", "판교", "정자", "야탑", "일산", "탄현", "중동", "상동", "부평", "구월동", "송도", "청라",
    "논현", "역삼", "선릉", "삼성", "성수", "연남", "합정", "상수", "망원", "공덕", "마포", "잠실", "석촌", "문정", "건대", "왕십리", "운정", "파주운정"
  ].map(normalizeText_);

  return badWords.includes(normalized);
}

function isLocationToken_(word) {
  const normalized = normalizeText_(word);
  const locationTokens = [
    "서울", "서울시", "서울특별시", "경기", "경기도", "인천", "인천광역시",
    "강남", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사", "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포", "공덕",
    "송파", "잠실", "석촌", "문정", "건대", "왕십리", "여의도", "용산",
    "수원", "호매실", "광교", "분당", "서현", "판교", "성남", "일산", "탄현", "부천", "안양", "하남", "남양주",
    "용인", "동탄", "평택", "화성", "김포", "파주", "운정", "파주운정", "의정부", "구리", "광명", "시흥", "안산", "군포", "의왕", "과천",
    "송도", "청라", "부평", "구월", "구월동", "성동", "이천", "굴포천", "구래", "장기동", "석모리", "야당", "반월", "중앙", "중앙역", "상암동", "난지"
  ].map(normalizeText_);

  return locationTokens.includes(normalized);
}

/***********************
 * 6. 점수/중복/0컨택
 ***********************/

function scoreDb_(query, postdate, address, category, zeroStatus) {
  let score = 0;
  score += 20;
  if (query.includes("강남맛집")) score += 30;
  if (query.includes("디너의여왕")) score += 25;
  if (query.includes("리뷰노트")) score += 15;
  if (query.includes("레뷰")) score += 12;
  if (query.includes("미블")) score += 12;
  if (query.includes("서울오빠")) score += 12;
  if (query.includes("식사권")) score += 15;
  if (isTargetArea_(address)) score += 25;
  if (isFoodCategory_(category)) score += 20;

  if (postdate) {
    const year = Number(postdate.substring(0, 4));
    const month = Number(postdate.substring(4, 6)) - 1;
    const day = Number(postdate.substring(6, 8));
    const postDateObj = new Date(year, month, day);
    const today = new Date();
    const diffDays = (today.getTime() - postDateObj.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays <= 30) score += 20;
    else if (diffDays <= 90) score += 10;
  }

  if (zeroStatus === "0컨택중") score -= 50;
  if (isCafeLightCategory_(category)) score -= 15;

  let grade = "C";
  if (score >= 105) grade = "S";
  else if (score >= 75) grade = "A";
  else if (score >= 50) grade = "B";

  if (grade === "S" && isCafeLightCategory_(category)) grade = "A";
  return { score, grade };
}

function isCafeLightCategory_(category) {
  if (!category) return false;
  const lightWords = ["카페", "디저트", "케이크", "베이커리", "샐러드", "다이어트", "쥬스", "주스", "버거", "피자"];
  return lightWords.some(word => category.includes(word));
}

function makeDbKey_(name, address) {
  const raw = `${name}|${address}`.toLowerCase().replace(/\s/g, "");
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw));
}

function getExistingDbKeys_(finalSheet) {
  const lastRow = finalSheet.getLastRow();
  const keys = {};
  if (lastRow < 2) return keys;

  const values = finalSheet.getRange(2, 2, lastRow - 1, 1).getValues();
  values.forEach(row => {
    const key = row[0];
    if (key && key !== "TEST_KEY") keys[key] = true;
  });
  return keys;
}

function getZeroContactRows_(zeroSheet) {
  const lastRow = zeroSheet.getLastRow();
  const rows = [];
  if (lastRow < 2) return rows;

  const values = zeroSheet.getRange(2, 1, lastRow - 1, 9).getValues();
  values.forEach(row => {
    const companyName = String(row[3] || "").trim();
    const address = String(row[4] || "").trim();
    if (companyName || address) {
      rows.push({
        name: companyName,
        address,
        nameKey: normalizeText_(companyName),
        addressAreaKey: extractAddressAreaKey_(address),
        exactKey: companyName && address ? makeDbKey_(companyName, address) : ""
      });
    }
  });
  return rows;
}

function isZeroContacted_(localName, realAddress, zeroRows) {
  const targetExactKey = makeDbKey_(localName, realAddress);
  const targetNameKey = normalizeText_(localName);
  const targetAreaKey = extractAddressAreaKey_(realAddress);

  for (let i = 0; i < zeroRows.length; i++) {
    const zero = zeroRows[i];
    if (zero.exactKey && zero.exactKey === targetExactKey) return true;

    const sameArea = zero.addressAreaKey && targetAreaKey && zero.addressAreaKey === targetAreaKey;
    const sameName = zero.nameKey && targetNameKey && zero.nameKey === targetNameKey;
    const containsName = zero.nameKey && targetNameKey && zero.nameKey.length >= 4 && targetNameKey.length >= 4 && (zero.nameKey.includes(targetNameKey) || targetNameKey.includes(zero.nameKey));

    if (sameArea && (sameName || containsName)) return true;
  }
  return false;
}

function extractAddressAreaKey_(address) {
  if (!address) return "";
  const parts = cleanText_(address).split(" ").filter(Boolean);
  if (parts.length >= 2) return normalizeText_(parts[0] + parts[1]);
  return normalizeText_(address);
}

function makeSalesMent_(query, zeroStatus) {
  if (zeroStatus === "0컨택중") return "이미 0컨택리스트에 있는 업체입니다. 최초 컨택 금지.";
  if (query.includes("강남맛집")) return "대표님, 기존에 강남맛집 쪽으로 블로그 리뷰 진행하신 흔적 보고 연락드렸습니다. 리뷰는 쌓이셨을 텐데 실제 플레이스 유입이나 전화 문의까지 연결은 괜찮으셨어요?";
  if (query.includes("디너의여왕")) return "대표님, 기존에 디너의여왕 쪽으로 체험단 리뷰 진행하신 흔적 보고 연락드렸습니다. 체험단 이후 실제 전화나 예약 문의까지 연결은 잘 되고 계세요?";
  if (query.includes("리뷰노트") || query.includes("레뷰") || query.includes("미블") || query.includes("서울오빠")) return "대표님, 기존에 블로그 체험단이나 리뷰 플랫폼을 이용하신 흔적 보고 연락드렸습니다. 리뷰 진행 후 실제 플레이스 유입이나 전화 문의까지 연결은 잘 되고 계세요?";
  return "대표님, 최근에 블로그 리뷰나 체험단 진행하신 흔적 보고 연락드렸습니다. 리뷰 진행 후 실제 플레이스 유입이나 전화 문의까지 연결은 잘 되고 계세요?";
}

function calcEvidenceMatchScore_(localName, address, roadAddress, region, rawText) {
  const raw = normalizeCompact_(rawText);
  const name = normalizeCompact_(localName);
  const reg = normalizeCompact_(region);
  let score = 0;

  if (name && raw.includes(name)) score += 50;

  getNameTokensForEvidence_(localName).forEach(token => {
    if (token.length >= 3 && raw.includes(token)) score += 20;
  });

  extractBranchTokens_(localName + " " + address + " " + roadAddress).forEach(token => {
    if (token.length >= 2 && raw.includes(token)) score += 25;
  });

  extractRoadTokens_(roadAddress).forEach(token => {
    if (token.length >= 3 && raw.includes(token)) score += 30;
  });

  extractDongTokens_(address + " " + roadAddress + " " + region).forEach(token => {
    if (token.length >= 2 && raw.includes(token)) score += 15;
  });

  if (reg && raw.includes(reg)) score += 10;
  return score;
}

function getNameTokensForEvidence_(name) {
  return String(name || "")
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/점/g, " ")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(normalizeCompact_)
    .filter(token => token.length >= 3)
    .filter(token => !["맛집", "술집", "고기집", "식당", "음식점", "리뷰", "후기", "서울", "경기", "인천", "수도권"].includes(token));
}

function extractBranchTokens_(text) {
  const knownBranches = ["강남", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사", "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포", "잠실", "석촌", "송파", "문정", "방이", "수원", "호매실", "광교", "분당", "서현", "판교", "인천", "송도", "청라", "부평", "구월", "동탄", "영천", "구리"];
  const normalized = normalizeCompact_(text);
  return knownBranches.map(normalizeCompact_).filter(token => normalized.includes(token));
}

function extractRoadTokens_(roadAddress) {
  const matches = String(roadAddress || "").match(/[가-힣0-9]+(?:로|길)[0-9]*번?길?/g);
  if (!matches) return [];
  return matches.map(normalizeCompact_);
}

function extractDongTokens_(text) {
  const matches = String(text || "").match(/[가-힣]+동/g);
  if (!matches) return [];
  return matches.map(normalizeCompact_);
}

/***********************
 * 7. 텍스트 유틸
 ***********************/

function cleanText_(value) {
  if (!value) return "";
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText_(value) {
  return cleanText_(value).toLowerCase().replace(/\s+/g, "").replace(/[^\w가-힣]/g, "");
}

function normalizeCompact_(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}

/***********************
 * 8. 기존 함수명 호환용 래퍼
 * 기존 드롭다운에 익숙한 경우를 위한 별칭
 ***********************/

function WAREHOUSE3_1_installSheetsKeepData() { SEUM_V1_0_installSheets(); }
function WAREHOUSE3_2_testNaverApi() { SEUM_V1_1_testNaverApi(); }
function WAREHOUSE3_3_clearWorkingOnly() { SEUM_V1_2_clearWorkingOnly(); }
function WAREHOUSE3_4_collectRealTest() { SEUM_V1_collect_TestSmall(); }
function WAREHOUSE3_5_collectBatch_SeoulHot() { SEUM_V1_collect_1_SeoulCore(); }
function WAREHOUSE3_6_collectBatch_SeoulMore() { SEUM_V1_collect_2_SeoulMore(); }
function WAREHOUSE3_7_collectBatch_Gyeonggi() { SEUM_V1_collect_3_GyeonggiCore(); }
function WAREHOUSE3_8_collectBatch_Incheon() { SEUM_V1_collect_4_Incheon(); }
function WAREHOUSE3_9_checkWarehouseStatus() { SEUM_V1_4_checkStatus(); }
function WAREHOUSE4_1_collectPlatformCore() { SEUM_V1_collect_5_PlatformCore(); }
function WAREHOUSE4_2_collectReviewPlatforms() { SEUM_V1_collect_6_ReviewPlatforms(); }
function WAREHOUSE4_3_collectGeneralProvidedTerms() { SEUM_V1_collect_7_GeneralProvidedTerms(); }
function WAREHOUSE4_4_collectMoreGyeonggi() { SEUM_V1_collect_8_MoreGyeonggi(); }
function WAREHOUSE44_1_cleanMismatchRowsByRawStrict() { SpreadsheetApp.getUi().alert("오매칭 정리: " + cleanMismatchRowsByRawStrict_() + "건 삭제"); }
function WAREHOUSE45_1_cleanDuplicateEvidenceLinks() { SpreadsheetApp.getUi().alert("근거링크 중복 정리: " + cleanDuplicateEvidenceLinks_() + "건 삭제"); }
function WAREHOUSE46_1_cleanCurrentBatchQualityIssues() { SpreadsheetApp.getUi().alert("품질 정리: " + cleanCurrentBatchQualityIssues_() + "건 삭제"); }
function SEUM_V1_2_checkFirstVersionStatus() { SEUM_V1_4_checkStatus(); }
/***********************
 * SEUM V1.1 브랜드/건물명 오매칭 정리
 * 목적:
 * 1) 파크하비오, 코엑스, 백화점 등 장소명만 맞고 실제 브랜드명이 안 맞는 행 삭제
 * 2) 뚜레쥬르 파크하비오점 같은 오매칭 방지
 ***********************/

function SEUM_V11_1_cleanBrandBranchMismatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(typeof WAREHOUSE_FINAL_SHEET !== "undefined" ? WAREHOUSE_FINAL_SHEET : "최종DB_창고");
  const rawSheet = ss.getSheetByName("원본수집");

  if (!finalSheet || !rawSheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 또는 원본수집 시트를 찾을 수 없습니다.");
    return;
  }

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();

  if (finalLastRow < 2 || rawLastRow < 2) {
    SpreadsheetApp.getUi().alert("정리할 데이터가 없습니다.");
    return;
  }

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (
    nameCol < 0 || linkCol < 0 ||
    rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0
  ) {
    SpreadsheetApp.getUi().alert("헤더 확인이 필요합니다.");
    return;
  }

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;

    const title = String(row[rawTitleCol] || "");
    const desc = String(row[rawDescCol] || "");
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";

    rawMap[link] = title + " " + desc + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();

  let deleteRows = [];
  let deletedNames = [];

  finalValues.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = String(row[nameCol] || "").trim();
    const link = String(row[linkCol] || "").trim();

    if (!link || !rawMap[link]) return;

    const rawText = rawMap[link];

    if (isBrandBranchMismatchV11(name, rawText)) {
      deleteRows.push(rowNumber);
      deletedNames.push(rowNumber + "행 " + name);
    }
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);

  deleteRows.forEach(rowNum => {
    finalSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.getUi().alert(
    "브랜드/건물명 오매칭 정리 완료\n\n" +
    "삭제된 행: " + deleteRows.length + "건\n\n" +
    deletedNames.slice(0, 15).join("\n")
  );
}

function isBrandBranchMismatchV11(localName, rawText) {
  const raw = normalizeTextV11(rawText);
  const coreTokens = getCoreBrandTokensV11(localName);

  if (coreTokens.length === 0) {
    return false;
  }

  for (let i = 0; i < coreTokens.length; i++) {
    const token = coreTokens[i];

    if (token.length >= 3 && raw.includes(token)) {
      return false;
    }
  }

  return true;
}

function getCoreBrandTokensV11(name) {
  return String(name || "")
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/점/g, " ")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(token => normalizeTextV11(token))
    .filter(token => token.length >= 3)
    .filter(token => !isBranchOrLocationTokenV11(token))
    .filter(token => !isGenericFoodTokenV11(token));
}

function normalizeTextV11(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}

function isBranchOrLocationTokenV11(token) {
  const words = [
    "파크하비오", "코엑스", "현대백화점", "롯데백화점", "신세계백화점",
    "스타필드", "아울렛", "몰", "타워", "스퀘어", "센트럴",
    "강남", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사",
    "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포",
    "잠실", "석촌", "송파", "문정", "방이", "왕십리",
    "수원", "호매실", "광교", "분당", "서현", "판교",
    "인천", "송도", "청라", "부평", "구월", "검단", "검단신도시",
    "동탄", "평택", "화성", "김포", "파주", "운정",
    "의정부", "구리", "광명", "시흥", "안산", "군포", "의왕", "과천",
    "상갈", "야탑", "동암"
  ].map(normalizeTextV11);

  return words.includes(token);
}

function isGenericFoodTokenV11(token) {
  const words = [
    "맛집", "술집", "고기집", "식당", "음식점", "카페", "디저트",
    "베이커리", "샐러드", "도시락", "다이어트", "푸드",
    "족발", "보쌈", "닭갈비", "한정식", "삼겹살"
  ].map(normalizeTextV11);

  return words.includes(token);
}
/***********************
 * SEUM V1.2 업종단어 오매칭 정리
 * 목적:
 * 1) 이자카야/주점/포차/술집 같은 업종 단어만 맞는 오매칭 삭제
 * 2) 실제 브랜드명/업체명이 블로그 제목·요약에 없으면 삭제
 * 3) 이자카야 찬 / 이자카야 고코 / 메기 이자카야 같은 케이스 제거
 ***********************/

function SEUM_V12_1_cleanGenericBusinessWordMismatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(typeof WAREHOUSE_FINAL_SHEET !== "undefined" ? WAREHOUSE_FINAL_SHEET : "최종DB_창고");
  const rawSheet = ss.getSheetByName("원본수집");

  if (!finalSheet || !rawSheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 또는 원본수집 시트를 찾을 수 없습니다.");
    return;
  }

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();

  if (finalLastRow < 2 || rawLastRow < 2) {
    SpreadsheetApp.getUi().alert("정리할 데이터가 없습니다.");
    return;
  }

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (
    nameCol < 0 || linkCol < 0 ||
    rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0
  ) {
    SpreadsheetApp.getUi().alert("헤더 확인이 필요합니다.");
    return;
  }

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;

    const title = String(row[rawTitleCol] || "");
    const desc = String(row[rawDescCol] || "");
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";

    if (!rawMap[link]) rawMap[link] = "";
    rawMap[link] += " " + title + " " + desc + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();

  let deleteRows = [];
  let deletedNames = [];

  finalValues.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = String(row[nameCol] || "").trim();
    const link = String(row[linkCol] || "").trim();

    if (!link || !rawMap[link]) return;

    const rawText = rawMap[link];

    if (!hasRealBrandMatchV12(name, rawText)) {
      deleteRows.push(rowNumber);
      deletedNames.push(rowNumber + "행 " + name);
    }
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);

  deleteRows.forEach(rowNum => {
    finalSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.getUi().alert(
    "업종단어 오매칭 정리 완료\n\n" +
    "삭제된 행: " + deleteRows.length + "건\n\n" +
    deletedNames.slice(0, 20).join("\n")
  );
}

function hasRealBrandMatchV12(localName, rawText) {
  const raw = normalizeTextV12(rawText);
  const fullNameKey = normalizeTextV12(removeBranchWordsV12(localName));

  // 전체 업체명 또는 핵심 업체명이 블로그에 그대로 있으면 정상
  if (fullNameKey.length >= 4 && raw.includes(fullNameKey)) {
    return true;
  }

  const brandTokens = getRealBrandTokensV12(localName);

  // 2글자 이상 브랜드 토큰이 블로그에 있어야 정상
  for (let i = 0; i < brandTokens.length; i++) {
    const token = brandTokens[i];

    if (token.length >= 2 && raw.includes(token)) {
      return true;
    }
  }

  return false;
}

function getRealBrandTokensV12(name) {
  return String(name || "")
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/점/g, " ")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(token => normalizeTextV12(token))
    .filter(token => token.length >= 2)
    .filter(token => !isGenericBusinessTokenV12(token))
    .filter(token => !isBranchOrLocationTokenV12(token));
}

function removeBranchWordsV12(name) {
  return String(name || "")
    .replace(/본점/g, "")
    .replace(/직영점/g, "")
    .replace(/[0-9]+호점/g, "")
    .replace(/점/g, "")
    .replace(/강남/g, "")
    .replace(/신논현/g, "")
    .replace(/광명/g, "")
    .replace(/송도/g, "")
    .replace(/청라/g, "")
    .replace(/부평/g, "")
    .replace(/구월/g, "")
    .replace(/수원/g, "")
    .replace(/분당/g, "")
    .replace(/판교/g, "")
    .replace(/역삼/g, "")
    .replace(/논현/g, "")
    .replace(/성수/g, "")
    .replace(/홍대/g, "")
    .replace(/신촌/g, "")
    .replace(/잠실/g, "");
}

function normalizeTextV12(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}

function isGenericBusinessTokenV12(token) {
  const words = [
    "맛집",
    "술집",
    "고기집",
    "식당",
    "음식점",
    "카페",
    "디저트",
    "베이커리",
    "샐러드",
    "도시락",
    "다이어트",
    "푸드",
    "족발",
    "보쌈",
    "닭갈비",
    "한정식",
    "삼겹살",
    "이자카야",
    "주점",
    "요리주점",
    "포차",
    "포장마차",
    "라멘",
    "초밥",
    "스시",
    "고기",
    "숯불",
    "오마카세",
    "호프",
    "맥주"
  ].map(normalizeTextV12);

  return words.includes(token);
}

function isBranchOrLocationTokenV12(token) {
  const words = [
    "강남", "신논현", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사",
    "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포",
    "잠실", "석촌", "송파", "문정", "방이", "왕십리",
    "수원", "호매실", "광교", "분당", "서현", "판교",
    "인천", "송도", "청라", "부평", "구월", "동암", "검단", "검단신도시",
    "동탄", "평택", "화성", "김포", "파주", "운정",
    "의정부", "구리", "광명", "시흥", "안산", "군포", "의왕", "과천",
    "상갈", "야탑", "광화문", "종로"
  ].map(normalizeTextV12);

  return words.includes(token);
}
/***********************
 * SEUM V1.3 약한 브랜드매칭 / 리뷰문맥 없음 정리
 * 목적:
 * 1) 화로구이/참숯/구이/김량장 같은 일반·지역 단어만 맞는 오매칭 삭제
 * 2) 음식점 리뷰 문맥이 없는 일반 글 삭제
 * 3) 담가 / 고철상 / 허수아비 같은 케이스 제거
 ***********************/

function SEUM_V13_1_cleanWeakBrandAndNoContextMismatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(typeof WAREHOUSE_FINAL_SHEET !== "undefined" ? WAREHOUSE_FINAL_SHEET : "최종DB_창고");
  const rawSheet = ss.getSheetByName("원본수집");

  if (!finalSheet || !rawSheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 또는 원본수집 시트를 찾을 수 없습니다.");
    return;
  }

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();

  if (finalLastRow < 2 || rawLastRow < 2) {
    SpreadsheetApp.getUi().alert("정리할 데이터가 없습니다.");
    return;
  }

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (
    nameCol < 0 || linkCol < 0 ||
    rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0
  ) {
    SpreadsheetApp.getUi().alert("헤더 확인이 필요합니다.");
    return;
  }

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;

    const title = String(row[rawTitleCol] || "");
    const desc = String(row[rawDescCol] || "");
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";

    if (!rawMap[link]) rawMap[link] = "";
    rawMap[link] += " " + title + " " + desc + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();

  let deleteRows = [];
  let deletedNames = [];

  finalValues.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = String(row[nameCol] || "").trim();
    const link = String(row[linkCol] || "").trim();

    if (!link || !rawMap[link]) return;

    const rawText = rawMap[link];

    const brandOk = hasRealBrandMatchV13(name, rawText);
    const contextOk = hasFoodReviewContextV13(rawText);

    if (!brandOk || !contextOk) {
      deleteRows.push(rowNumber);
      deletedNames.push(
        rowNumber + "행 " + name +
        " / 브랜드일치:" + brandOk +
        " / 리뷰문맥:" + contextOk
      );
    }
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);

  deleteRows.forEach(rowNum => {
    finalSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.getUi().alert(
    "V1.3 약한매칭/리뷰문맥 정리 완료\n\n" +
    "삭제된 행: " + deleteRows.length + "건\n\n" +
    deletedNames.slice(0, 20).join("\n")
  );
}

function hasRealBrandMatchV13(localName, rawText) {
  const raw = normalizeTextV13(rawText);
  const brandTokens = getRealBrandTokensV13(localName);

  if (brandTokens.length === 0) {
    return false;
  }

  for (let i = 0; i < brandTokens.length; i++) {
    const token = brandTokens[i];

    if (token.length >= 2 && raw.includes(token)) {
      return true;
    }
  }

  return false;
}

function getRealBrandTokensV13(name) {
  return String(name || "")
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/직영/g, " ")
    .replace(/본관/g, " ")
    .replace(/별관/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/점/g, " ")
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(token => normalizeTextV13(token))
    .filter(token => token.length >= 2)
    .filter(token => !isGenericBusinessTokenV13(token))
    .filter(token => !isBranchOrLocationTokenV13(token));
}

function hasFoodReviewContextV13(rawText) {
  const text = String(rawText || "");

  const contextWords = [
    "식사권",
    "제공받",
    "체험",
    "업체",
    "협찬",
    "무료",
    "방문후기",
    "방문 후기",
    "솔직하게 작성",
    "후기",
    "리뷰",
    "맛집",
    "방문",
    "메뉴",
    "매장",
    "음식",
    "고기",
    "식당",
    "라스트오더",
    "운영시간",
    "영업시간",
    "주차",
    "주소",
    "전화",
    "예약",
    "주문",
    "가격",
    "분위기",
    "맛있",
    "먹었",
    "먹어"
  ];

  return contextWords.some(word => text.includes(word));
}

function normalizeTextV13(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}

function isGenericBusinessTokenV13(token) {
  const words = [
    "맛집",
    "술집",
    "고기집",
    "식당",
    "음식점",
    "카페",
    "디저트",
    "베이커리",
    "샐러드",
    "도시락",
    "다이어트",
    "푸드",
    "족발",
    "보쌈",
    "닭갈비",
    "한정식",
    "삼겹살",
    "이자카야",
    "주점",
    "요리주점",
    "포차",
    "포장마차",
    "라멘",
    "초밥",
    "스시",
    "고기",
    "고깃집",
    "숯불",
    "오마카세",
    "호프",
    "맥주",
    "화로구이",
    "참숯",
    "참숯화로",
    "숯불구이",
    "구이",
    "갈비",
    "회식장소",
    "처인구고기집",
    "용인고기집",
    "수제비",
    "닭볶음탕",
    "감자탕",
    "냉면",
    "국밥",
    "파전"
  ].map(normalizeTextV13);

  return words.includes(token);
}

function isBranchOrLocationTokenV13(token) {
  const words = [
    "강남", "신논현", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사",
    "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포",
    "잠실", "석촌", "송파", "문정", "방이", "왕십리",
    "수원", "수원남문", "남문", "호매실", "광교", "분당", "서현", "판교",
    "인천", "송도", "청라", "부평", "구월", "동암", "검단", "검단신도시",
    "동탄", "평택", "화성", "김포", "파주", "운정",
    "의정부", "구리", "광명", "시흥", "안산", "군포", "의왕", "과천",
    "상갈", "야탑", "광화문", "종로",
    "용인", "용인상현", "상현", "김량장", "처인구", "수지", "기흥", "풍덕천", "동천"
  ].map(normalizeTextV13);

  return words.includes(token);
}
/***********************
 * SEUM V1.4 음식업종 직접 검색어 확장
 * 목적:
 * 1) 맛집/술집처럼 넓은 단어보다 음식 업종명을 직접 검색
 * 2) 삼겹살/고깃집/족발/닭갈비 중심으로 음식점 DB 확장
 * 3) 기존 통합코드 구조 그대로 사용
 ***********************/

function SEUM_V14_collect_9_SeoulFoodTypes() {
  const queries = [];

  const regions = [
    "강남", "신논현", "논현", "역삼",
    "선릉", "삼성", "청담", "압구정",
    "성수", "연남", "합정", "잠실"
  ];

  const foods = [
    "삼겹살",
    "고깃집",
    "족발",
    "닭갈비"
  ];

  const traces = [
    "식사권을 제공받아",
    "업체로부터 식사권을 제공받아"
  ];

  regions.forEach(region => {
    foods.forEach(food => {
      traces.forEach(trace => {
        queries.push(`${region} ${food} ${trace}`);
      });
    });
  });

  collectSeumWarehouseByQueries_("SEUM_V14_collect_9_SeoulFoodTypes", queries, 3);
}
/***********************
 * SEUM V1.5 지점명 불일치 / 룸술집 정리
 * 목적:
 * 1) 조개창고 신천점처럼 실제 글의 지점과 다른 지점으로 매칭된 행 삭제
 * 2) 도깨비집 2호점처럼 룸술집 계열 삭제
 ***********************/

function SEUM_V15_1_cleanBranchMismatchAndRoomPub() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(typeof WAREHOUSE_FINAL_SHEET !== "undefined" ? WAREHOUSE_FINAL_SHEET : "최종DB_창고");
  const rawSheet = ss.getSheetByName("원본수집");

  if (!finalSheet || !rawSheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 또는 원본수집 시트를 찾을 수 없습니다.");
    return;
  }

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();

  if (finalLastRow < 2 || rawLastRow < 2) {
    SpreadsheetApp.getUi().alert("정리할 데이터가 없습니다.");
    return;
  }

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const addrCol = finalHeaders.indexOf("주소");
  const roadCol = finalHeaders.indexOf("도로명주소");
  const regionCol = finalHeaders.indexOf("지역");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (
    nameCol < 0 || addrCol < 0 || roadCol < 0 || regionCol < 0 || linkCol < 0 ||
    rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0
  ) {
    SpreadsheetApp.getUi().alert("헤더 확인이 필요합니다.");
    return;
  }

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();
  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;

    const title = String(row[rawTitleCol] || "");
    const desc = String(row[rawDescCol] || "");
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";

    if (!rawMap[link]) rawMap[link] = "";
    rawMap[link] += " " + title + " " + desc + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();

  let deleteRows = [];
  let deletedNames = [];

  finalValues.forEach((row, index) => {
    const rowNumber = index + 2;

    const name = String(row[nameCol] || "").trim();
    const address = String(row[addrCol] || "").trim();
    const roadAddress = String(row[roadCol] || "").trim();
    const region = String(row[regionCol] || "").trim();
    const link = String(row[linkCol] || "").trim();

    if (!link || !rawMap[link]) return;

    const rawText = rawMap[link];

    let reason = "";

    if (hasRoomPubContextV15(rawText, name)) {
      reason = "룸술집/룸주점 계열";
    } else if (hasBranchMismatchV15(name, address, roadAddress, region, rawText)) {
      reason = "지점명/지역 불일치";
    }

    if (reason) {
      deleteRows.push(rowNumber);
      deletedNames.push(rowNumber + "행 " + name + " / " + reason);
    }
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);

  deleteRows.forEach(rowNum => {
    finalSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.getUi().alert(
    "V1.5 지점/룸술집 정리 완료\n\n" +
    "삭제된 행: " + deleteRows.length + "건\n\n" +
    deletedNames.slice(0, 20).join("\n")
  );
}

function hasRoomPubContextV15(rawText, name) {
  const text = String(rawText || "") + " " + String(name || "");

  const badWords = [
    "룸술집",
    "룸 술집",
    "룸주점",
    "룸 주점",
    "노래타운",
    "노래방"
  ];

  return badWords.some(word => text.includes(word));
}

function hasBranchMismatchV15(name, address, roadAddress, region, rawText) {
  const raw = normalizeTextV15(rawText);
  const nameText = normalizeTextV15(name);

  // 지점 오매칭이 자주 나는 브랜드만 우선 강하게 검사
  const branchSensitiveBrands = [
    "조개창고",
    "백소정",
    "상무초밥",
    "미림양장",
    "뚜레쥬르",
    "애슐리퀸즈",
    "노브랜드버거",
    "강남교자",
    "텍사스데브라질",
    "스시도쿠"
  ].map(normalizeTextV15);

  const isSensitive = branchSensitiveBrands.some(brand => nameText.includes(brand));

  if (!isSensitive) {
    return false;
  }

  const branchTokens = extractBranchTokensV15(name, address, roadAddress, region);

  if (branchTokens.length === 0) {
    return false;
  }

  // 지점/동네 토큰 중 하나라도 블로그 제목/요약에 있으면 정상
  for (let i = 0; i < branchTokens.length; i++) {
    const token = branchTokens[i];

    if (token.length >= 2 && raw.includes(token)) {
      return false;
    }
  }

  return true;
}

function extractBranchTokensV15(name, address, roadAddress, region) {
  const text = String(name || "") + " " + String(address || "") + " " + String(roadAddress || "") + " " + String(region || "");

  let tokens = [];

  // 업체명 속 지점명 추출: 신천점, 압구정점, 성수본점 등
  const branchMatches = String(name || "").match(/[가-힣a-zA-Z0-9]+(?:본점|직영점|점)/g);
  if (branchMatches) {
    branchMatches.forEach(item => {
      let token = item
        .replace(/본점/g, "")
        .replace(/직영점/g, "")
        .replace(/점/g, "")
        .trim();

      if (token.length >= 2) tokens.push(token);
    });
  }

  // 주소 속 동네명 추출
  const dongMatches = text.match(/[가-힣]+동/g);
  if (dongMatches) {
    dongMatches.forEach(item => {
      tokens.push(item);
      tokens.push(item.replace(/동/g, ""));
    });
  }

  // 자주 쓰는 지역/상권 토큰
  const knownLocations = [
    "굴포천", "신천", "잠실", "잠실새내", "송파",
    "압구정", "신사", "강남", "논현", "역삼", "선릉", "삼성", "청담",
    "성수", "건대", "구로", "구로디지털단지",
    "합정", "망원", "홍대", "연남", "신촌",
    "수원", "광교", "호매실", "분당", "서현", "판교",
    "인천", "송도", "청라", "부평", "구월", "동암"
  ];

  knownLocations.forEach(loc => {
    if (text.includes(loc)) {
      tokens.push(loc);
    }
  });

  tokens = tokens
    .map(token => normalizeTextV15(token))
    .filter(token => token.length >= 2)
    .filter(token => !isTooGenericBranchTokenV15(token));

  return Array.from(new Set(tokens));
}

function isTooGenericBranchTokenV15(token) {
  const bad = [
    "서울",
    "경기",
    "인천",
    "본점",
    "직영",
    "직영점",
    "신촌점",
    "압구정점"
  ].map(normalizeTextV15);

  return bad.includes(token);
}

function normalizeTextV15(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}
/***********************
 * SEUM V1.6 경기/인천 음식업종 직접 검색어 확장
 * 목적:
 * 1) 경기/인천 쪽 삼겹살/고깃집/족발/닭갈비 중심 수집
 * 2) 맛집/술집보다 음식점 비율 높은 검색어 사용
 ***********************/

function SEUM_V16_collect_10_GyeonggiIncheonFoodTypes() {
  const queries = [];

  const regions = [
    "수원", "광교", "분당", "판교",
    "용인", "동탄", "화성", "평택",
    "김포", "파주", "구리", "광명",
    "인천", "송도", "청라", "부평", "구월", "검단"
  ];

  const foods = [
    "삼겹살",
    "고깃집",
    "족발",
    "닭갈비"
  ];

  const traces = [
    "식사권을 제공받아",
    "업체로부터 식사권을 제공받아"
  ];

  regions.forEach(region => {
    foods.forEach(food => {
      traces.forEach(trace => {
        queries.push(`${region} ${food} ${trace}`);
      });
    });
  });

  collectSeumWarehouseByQueries_("SEUM_V16_collect_10_GyeonggiIncheonFoodTypes", queries, 3);
}
/***********************
 * SEUM V1.7 실제 브랜드 불일치 정리
 * 목적:
 * 1) 블로그 글의 실제 업체명과 최종DB 업체명이 다른 경우 삭제
 * 2) 화통삼/상하이/족발야시장/든든한한끼/골목집 같은 오매칭 제거
 * 3) 여행글/일반글이 음식점으로 들어온 경우 제거
 ***********************/

function SEUM_V17_1_cleanRealBrandMismatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const finalSheet = ss.getSheetByName(typeof WAREHOUSE_FINAL_SHEET !== "undefined" ? WAREHOUSE_FINAL_SHEET : "최종DB_창고");
  const rawSheet = ss.getSheetByName("원본수집");

  if (!finalSheet || !rawSheet) {
    SpreadsheetApp.getUi().alert("최종DB_창고 또는 원본수집 시트를 찾을 수 없습니다.");
    return;
  }

  const finalLastRow = finalSheet.getLastRow();
  const rawLastRow = rawSheet.getLastRow();

  if (finalLastRow < 2 || rawLastRow < 2) {
    SpreadsheetApp.getUi().alert("정리할 데이터가 없습니다.");
    return;
  }

  const finalHeaders = finalSheet.getRange(1, 1, 1, finalSheet.getLastColumn()).getValues()[0];
  const rawHeaders = rawSheet.getRange(1, 1, 1, rawSheet.getLastColumn()).getValues()[0];

  const nameCol = finalHeaders.indexOf("업체명");
  const linkCol = finalHeaders.indexOf("근거링크");

  const rawTitleCol = rawHeaders.indexOf("블로그제목");
  const rawDescCol = rawHeaders.indexOf("블로그요약");
  const rawLinkCol = rawHeaders.indexOf("블로그링크");
  const rawCandidateCol = rawHeaders.indexOf("업체명후보");

  if (
    nameCol < 0 || linkCol < 0 ||
    rawTitleCol < 0 || rawDescCol < 0 || rawLinkCol < 0
  ) {
    SpreadsheetApp.getUi().alert("헤더 확인이 필요합니다.");
    return;
  }

  const rawValues = rawSheet.getRange(2, 1, rawLastRow - 1, rawSheet.getLastColumn()).getValues();

  const rawMap = {};

  rawValues.forEach(row => {
    const link = String(row[rawLinkCol] || "").trim();
    if (!link) return;

    const title = String(row[rawTitleCol] || "");
    const desc = String(row[rawDescCol] || "");
    const candidate = rawCandidateCol >= 0 ? String(row[rawCandidateCol] || "") : "";

    if (!rawMap[link]) rawMap[link] = "";
    rawMap[link] += " " + title + " " + desc + " " + candidate;
  });

  const finalValues = finalSheet.getRange(2, 1, finalLastRow - 1, finalSheet.getLastColumn()).getValues();

  let deleteRows = [];
  let deletedNames = [];

  finalValues.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = String(row[nameCol] || "").trim();
    const link = String(row[linkCol] || "").trim();

    if (!link || !rawMap[link]) return;

    const rawText = rawMap[link];

    let reason = "";

    if (isManualKnownMismatchV17(name, rawText)) {
      reason = "확인된 실제브랜드 불일치";
    } else if (isTravelOrNonFoodRawV17(rawText) && !hasStrongBrandInRawV17(name, rawText)) {
      reason = "여행/비음식 글";
    } else if (!hasStrongBrandInRawV17(name, rawText)) {
      reason = "블로그 글에 실제 업체명 없음";
    }

    if (reason) {
      deleteRows.push(rowNumber);
      deletedNames.push(rowNumber + "행 " + name + " / " + reason);
    }
  });

  deleteRows = Array.from(new Set(deleteRows)).sort((a, b) => b - a);

  deleteRows.forEach(rowNum => {
    finalSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.getUi().alert(
    "V1.7 실제 브랜드 불일치 정리 완료\n\n" +
    "삭제된 행: " + deleteRows.length + "건\n\n" +
    deletedNames.slice(0, 20).join("\n")
  );
}

function isManualKnownMismatchV17(name, rawText) {
  const n = normalizeTextV17(name);
  const raw = normalizeTextV17(rawText);

  const badPairs = [
    { finalName: "화통삼", actual: "마장동김씨" },
    { finalName: "상하이", actual: "상하이여행" },
    { finalName: "족발야시장", actual: "더맛있는족발보쌈" },
    { finalName: "든든한한끼", actual: "돼지울타리" },
    { finalName: "골목집", actual: "대복갈비" }
  ];

  for (let i = 0; i < badPairs.length; i++) {
    const item = badPairs[i];

    if (n.includes(normalizeTextV17(item.finalName)) && raw.includes(normalizeTextV17(item.actual))) {
      return true;
    }
  }

  return false;
}

function hasStrongBrandInRawV17(name, rawText) {
  const raw = normalizeTextV17(rawText);
  const tokens = getStrongBrandTokensV17(name);

  if (tokens.length === 0) {
    return false;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.length >= 2 && raw.includes(token)) {
      return true;
    }
  }

  return false;
}

function getStrongBrandTokensV17(name) {
  let text = String(name || "");

  text = text
    .replace(/&/g, " ")
    .replace(/\+/g, " ")
    .replace(/\//g, " ")
    .replace(/,/g, " ")
    .replace(/\(/g, " ")
    .replace(/\)/g, " ");

  return text
    .replace(/본점/g, " ")
    .replace(/직영점/g, " ")
    .replace(/직영/g, " ")
    .replace(/본관/g, " ")
    .replace(/별관/g, " ")
    .replace(/[0-9]+호점/g, " ")
    .replace(/[가-힣a-zA-Z0-9]+점/g, function(match) {
      const token = match.replace(/점/g, "");
      if (isLikelyBranchOnlyTokenV17(token)) {
        return " ";
      }
      return token;
    })
    .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(token => normalizeTextV17(token))
    .filter(token => token.length >= 2)
    .filter(token => !isGenericBusinessTokenV17(token))
    .filter(token => !isLocationOrBranchTokenV17(token))
    .filter(token => !isWeakGenericPhraseV17(token));
}

function isLikelyBranchOnlyTokenV17(token) {
  const t = normalizeTextV17(token);

  const branchWords = [
    "수원인계", "광명소하", "인천동암", "용인흥덕", "파주운정",
    "판교직영", "동탄", "송도", "청라", "부평", "구월",
    "신논현", "강남", "역삼", "선릉", "압구정", "사당",
    "역촌", "수원역", "오산"
  ].map(normalizeTextV17);

  return branchWords.includes(t);
}

function isGenericBusinessTokenV17(token) {
  const words = [
    "맛집", "술집", "고기집", "식당", "음식점",
    "카페", "디저트", "베이커리", "샐러드", "도시락",
    "다이어트", "푸드", "한끼",
    "족발", "보쌈", "족발보쌈", "닭갈비", "한정식",
    "삼겹살", "돼지갈비", "소갈비", "갈비",
    "이자카야", "주점", "요리주점", "포차", "포장마차",
    "라멘", "초밥", "스시", "고기", "고깃집",
    "숯불", "화로구이", "오마카세", "호프", "맥주",
    "중국집", "중식당", "중식", "상하이"
  ].map(normalizeTextV17);

  return words.includes(token);
}

function isLocationOrBranchTokenV17(token) {
  const words = [
    "서울", "경기", "인천", "수도권",
    "강남", "신논현", "논현", "역삼", "선릉", "삼성", "청담", "압구정", "신사", "사당",
    "성수", "홍대", "연남", "신촌", "합정", "상수", "망원", "마포",
    "잠실", "석촌", "송파", "문정", "방이", "왕십리", "구로", "구로디지털단지",
    "수원", "수원역", "수원인계", "인계", "호매실", "광교", "분당", "서현", "판교",
    "인천", "송도", "청라", "부평", "구월", "동암", "검단", "검단신도시",
    "동탄", "평택", "화성", "오산", "김포", "파주", "운정",
    "의정부", "구리", "광명", "광명소하", "소하", "시흥", "안산", "군포", "의왕", "과천",
    "상갈", "야탑", "광화문", "종로", "은평", "역촌",
    "용인", "용인흥덕", "흥덕", "상현", "처인구", "수지", "기흥", "영덕동",
    "가좌", "구월동", "산곡", "산곡동"
  ].map(normalizeTextV17);

  return words.includes(token);
}

function isWeakGenericPhraseV17(token) {
  const words = [
    "든든한", "든든한한끼", "한끼",
    "골목집", "상하이",
    "맛있는", "더맛있는", "최고의",
    "가고싶은", "구워주는", "추천",
    "있는", "좋은", "제대로"
  ].map(normalizeTextV17);

  return words.includes(token);
}

function isTravelOrNonFoodRawV17(rawText) {
  const text = String(rawText || "");

  const badWords = [
    "여행 일정",
    "자유여행",
    "상해 자유여행",
    "중국 상하이",
    "나나트래블",
    "할인쿠폰",
    "구매 상담",
    "갤럭시",
    "특가할인",
    "핸드폰",
    "스마트폰"
  ];

  return badWords.some(word => text.includes(word));
}

function normalizeTextV17(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .trim();
}
/***********************
 * SEUM V1.8 음식업종 2차 검색어 확장
 * 목적:
 * 국밥/칼국수/샤브샤브/횟집/중식 중심으로 음식점 DB 확장
 ***********************/

function SEUM_V18_collect_11_FoodTypesSecond() {
  const queries = [];

  const regions = [
    "강남", "논현", "역삼", "선릉", "삼성", "청담",
    "성수", "연남", "합정", "잠실", "송파",
    "수원", "광교", "분당", "판교", "용인", "동탄",
    "인천", "송도", "청라", "부평", "구월", "검단"
  ];

  const foods = [
    "국밥",
    "칼국수",
    "샤브샤브",
    "횟집",
    "중식"
  ];

  const traces = [
    "식사권을 제공받아",
    "업체로부터 식사권을 제공받아"
  ];

  regions.forEach(region => {
    foods.forEach(food => {
      traces.forEach(trace => {
        queries.push(`${region} ${food} ${trace}`);
      });
    });
  });

  collectSeumWarehouseByQueries_("SEUM_V18_collect_11_FoodTypesSecond", queries, 3);
}
/***********************
 * SEUM V1.8 분할 실행 버전
 * 목적:
 * 기존 SEUM_V18_collect_11_FoodTypesSecond 시간초과 방지
 * 4개로 쪼개서 실행
 ***********************/

function SEUM_V18A_collect_11_FoodTypesSecond_SeoulGangnam() {
  const regions = [
    "강남", "논현", "역삼", "선릉", "삼성", "청담"
  ];

  SEUM_V18_SPLIT_collectFoodTypes_("SEUM_V18A_collect_11_FoodTypesSecond_SeoulGangnam", regions);
}

function SEUM_V18B_collect_11_FoodTypesSecond_SeoulMore() {
  const regions = [
    "성수", "연남", "합정", "잠실", "송파", "수원"
  ];

  SEUM_V18_SPLIT_collectFoodTypes_("SEUM_V18B_collect_11_FoodTypesSecond_SeoulMore", regions);
}

function SEUM_V18C_collect_11_FoodTypesSecond_Gyeonggi() {
  const regions = [
    "광교", "분당", "판교", "용인", "동탄", "인천"
  ];

  SEUM_V18_SPLIT_collectFoodTypes_("SEUM_V18C_collect_11_FoodTypesSecond_Gyeonggi", regions);
}

function SEUM_V18D_collect_11_FoodTypesSecond_IncheonMore() {
  const regions = [
    "송도", "청라", "부평", "구월", "검단", "광명"
  ];

  SEUM_V18_SPLIT_collectFoodTypes_("SEUM_V18D_collect_11_FoodTypesSecond_IncheonMore", regions);
}

function SEUM_V18_SPLIT_collectFoodTypes_(runName, regions) {
  const queries = [];

  const foods = [
    "국밥",
    "칼국수",
    "샤브샤브",
    "횟집",
    "중식"
  ];

  const traces = [
    "식사권을 제공받아",
    "업체로부터 식사권을 제공받아"
  ];

  regions.forEach(region => {
    foods.forEach(food => {
      traces.forEach(trace => {
        queries.push(`${region} ${food} ${trace}`);
      });
    });
  });

  collectSeumWarehouseByQueries_(runName, queries, 3);
}
/***********************
 * SEUM V1.8 초소형 분할 실행 버전
 * 목적:
 * 1) 6분 시간초과 방지
 * 2) 1회 실행 검색어 20개 단위
 * 3) 검색결과도 query당 2개만 수집해서 안정성 우선
 ***********************/

function SEUM_V18A1_collect_Gangnam_Nonhyeon() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18A1_collect_Gangnam_Nonhyeon", ["강남", "논현"]);
}

function SEUM_V18A2_collect_Yeoksam_Seolleung() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18A2_collect_Yeoksam_Seolleung", ["역삼", "선릉"]);
}

function SEUM_V18A3_collect_Samsung_Cheongdam() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18A3_collect_Samsung_Cheongdam", ["삼성", "청담"]);
}

function SEUM_V18B1_collect_Seongsu_Yeonnam() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18B1_collect_Seongsu_Yeonnam", ["성수", "연남"]);
}

function SEUM_V18B2_collect_Hapjeong_Jamsil() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18B2_collect_Hapjeong_Jamsil", ["합정", "잠실"]);
}

function SEUM_V18B3_collect_Songpa_Suwon() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18B3_collect_Songpa_Suwon", ["송파", "수원"]);
}

function SEUM_V18C1_collect_Gwanggyo_Bundang() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18C1_collect_Gwanggyo_Bundang", ["광교", "분당"]);
}

function SEUM_V18C2_collect_Pangyo_Yongin() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18C2_collect_Pangyo_Yongin", ["판교", "용인"]);
}

function SEUM_V18C3_collect_Dongtan_Incheon() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18C3_collect_Dongtan_Incheon", ["동탄", "인천"]);
}

function SEUM_V18D1_collect_Songdo_Cheongna() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18D1_collect_Songdo_Cheongna", ["송도", "청라"]);
}

function SEUM_V18D2_collect_Bupyeong_Guwol() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18D2_collect_Bupyeong_Guwol", ["부평", "구월"]);
}

function SEUM_V18D3_collect_Geomdan_Gwangmyeong() {
  SEUM_V18_MICRO_collectFoodTypes_("SEUM_V18D3_collect_Geomdan_Gwangmyeong", ["검단", "광명"]);
}

function SEUM_V18_MICRO_collectFoodTypes_(runName, regions) {
  const queries = [];

  const foods = [
    "국밥",
    "칼국수",
    "샤브샤브",
    "횟집",
    "중식"
  ];

  const traces = [
    "식사권을 제공받아",
    "업체로부터 식사권을 제공받아"
  ];

  regions.forEach(region => {
    foods.forEach(food => {
      traces.forEach(trace => {
        queries.push(`${region} ${food} ${trace}`);
      });
    });
  });

  // query당 2개만 가져와서 시간초과 방지
  collectSeumWarehouseByQueries_(runName, queries, 2);
}
