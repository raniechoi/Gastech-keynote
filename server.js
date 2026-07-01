/**
 * 수정 대상: server.js의 generateWordFromTemplate 함수
 * 
 * STEP17의 기존 코드를 유지하되,
 * 템플릿 파일이 없으면 docx 라이브러리로 직접 생성하도록 수정
 */

// 기존 코드 대신 이 함수를 사용하세요:

const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');

/**
 * Word 문서 생성 (하이브리드 방식)
 * 1. 템플릿 파일이 있으면 → JSZip으로 placeholder 교체
 * 2. 템플릿 파일이 없으면 → docx 라이브러리로 직접 생성
 */
async function generateWordFromTemplate(insightData) {
  try {
    const JSZip = require('jszip');
    
    // 템플릿 파일 경로 시도
    const templatePaths = [
      path.join(__dirname, 'template', 'compet_template.docx'),
      path.join(__dirname, '컨퍼런스_MOM_Templete.docx'),
      path.join(__dirname, 'compet_template.docx')
    ];

    let templateBuffer = null;
    let templateExists = false;

    // 템플릿 파일 찾기
    for (const templatePath of templatePaths) {
      if (fs.existsSync(templatePath)) {
        try {
          templateBuffer = fs.readFileSync(templatePath);
          templateExists = true;
          console.log(`✓ 템플릿 파일 발견: ${templatePath}`);
          break;
        } catch (e) {
          console.log(`템플릿 읽기 실패: ${templatePath}`);
          continue;
        }
      }
    }

    // 방법 1: 템플릿 파일이 있으면 JSZip 사용
    if (templateExists && templateBuffer) {
      console.log('📋 템플릿 기반 Word 생성 중...');
      return await generateFromTemplate(templateBuffer, insightData);
    }
    
    // 방법 2: 템플릿 파일이 없으면 docx 직접 생성
    else {
      console.log('📝 docx 라이브러리로 Word 생성 중...');
      return await generateFromScratch(insightData);
    }

  } catch (error) {
    console.error('Word 생성 에러:', error);
    // 마지막 방법: docx로 직접 생성
    console.log('🔄 docx 직접 생성으로 폴백...');
    return await generateFromScratch(insightData);
  }
}

/**
 * 방법 1: 템플릿 파일이 있을 때 (JSZip 사용)
 */
async function generateFromTemplate(templateBuffer, insightData) {
  try {
    const JSZip = require('jszip');
    
    const zip = new JSZip();
    await zip.loadAsync(templateBuffer);

    let documentXml = await zip.file('word/document.xml').async('string');

    // 데이터 추출
    const speakerName = insightData.speaker_name || '(정보 없음)';
    const speakerTitle = insightData.speaker_title || '(정보 없음)';
    const date = insightData.date || '(정보 없음)';
    const time = insightData.time || '(정보 없음)';
    const insights = insightData.insights || [];

    // Placeholder 교체
    const replaceInXml = (xml, placeholder, value) => {
      const regex = new RegExp(`\\[${placeholder}\\]`, 'g');
      return xml.replace(regex, value || '');
    };

    documentXml = replaceInXml(documentXml, '연사 이름', speakerName);
    documentXml = replaceInXml(documentXml, '회사명', '');
    documentXml = replaceInXml(documentXml, '직급', speakerTitle);
    documentXml = replaceInXml(documentXml, '세션 날짜', date);
    documentXml = replaceInXml(documentXml, '시간', time);

    // Insight 교체
    for (let i = 0; i < Math.min(insights.length, 3); i++) {
      const insight = insights[i];
      const insightNum = i + 1;

      documentXml = replaceInXml(documentXml, `Insight ${insightNum}`, insight.main || '');

      if (insight.subs && Array.isArray(insight.subs)) {
        for (let j = 0; j < Math.min(insight.subs.length, 2); j++) {
          documentXml = replaceInXml(
            documentXml, 
            `Insight ${insightNum}에 대한 부연설명 ${j + 1}`, 
            insight.subs[j] || ''
          );
        }
      }
    }

    // 사용하지 않은 placeholder 제거
    documentXml = documentXml.replace(/\[[^\]]+\]/g, '');

    zip.file('word/document.xml', documentXml);

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return buffer;

  } catch (error) {
    console.error('템플릿 기반 생성 실패:', error);
    throw error;
  }
}

/**
 * 방법 2: 템플릿 파일이 없을 때 (docx 직접 생성)
 */
async function generateFromScratch(insightData) {
  try {
    const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');

    const createRun = (text, isBold = false, size = 28) => {
      return new TextRun({
        text: text,
        font: '바탕체',
        size: size,
        bold: isBold,
        color: '000000'
      });
    };

    const paragraphs = [];

    // 제목
    if (insightData.speaker_name && insightData.speaker_title) {
      const titleText = `【${insightData.speaker_name} - ${insightData.speaker_title}】`;
      paragraphs.push(
        new Paragraph({
          text: titleText,
          spacing: {
            line: 240,
            after: 0
          },
          runs: [createRun(titleText, true)]
        })
      );
    }

    // 날짜
    if (insightData.date && insightData.time) {
      const dateText = `※ ${insightData.date}, ${insightData.time}`;
      paragraphs.push(
        new Paragraph({
          text: dateText,
          spacing: {
            line: 240,
            after: 240
          },
          runs: [createRun(dateText, false, 22)]
        })
      );
    }

    // Insights
    if (insightData.insights && Array.isArray(insightData.insights)) {
      insightData.insights.forEach((insight) => {
        // 메인 인사이트
        const mainText = `- ${insight.main}`;
        paragraphs.push(
          new Paragraph({
            text: mainText,
            spacing: {
              line: 240,
              after: 240
            },
            runs: [createRun(mainText, false)]
          })
        );

        // 부연 설명
        if (insight.subs && Array.isArray(insight.subs)) {
          insight.subs.forEach((sub) => {
            const subText = `  · ${sub}`;
            paragraphs.push(
              new Paragraph({
                text: subText,
                spacing: {
                  line: 240,
                  after: 240
                },
                runs: [createRun(subText, false)]
              })
            );
          });
        }
      });
    }

    // Word 문서 생성
    const doc = new Document({
      sections: [{
        properties: {
          margins: {
            top: convertInchesToTwip(2.5 / 2.54),
            bottom: convertInchesToTwip(2.5 / 2.54),
            left: convertInchesToTwip(2.0 / 2.54),
            right: convertInchesToTwip(2.0 / 2.54)
          }
        },
        children: paragraphs
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    return buffer;

  } catch (error) {
    console.error('docx 직접 생성 실패:', error);
    throw error;
  }
}

module.exports = { generateWordFromTemplate };