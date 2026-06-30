import React, { useState, useRef, useEffect } from 'react';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [metadata, setMetadata] = useState({ speakerName: '', speakerTitle: '', date: '' });
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const fileInputRef = useRef(null);

  // API 기본 URL 설정
  useEffect(() => {
    const baseUrl = window.location.origin === 'http://localhost:3000' 
      ? 'http://localhost:5000'
      : window.location.origin.replace(':3000', ':5000');
    setApiBaseUrl(baseUrl);
    loadHistory(baseUrl);
  }, []);

  const loadHistory = async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/api/results`);
      const data = await response.json();
      setHistory(data.results || []);
    } catch (err) {
      console.error('이전 결과 로드 실패:', err);
    }
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setFileName(selectedFile.name);
      setError(null);
    }
  };

  const handleMetadataChange = (e) => {
    const { name, value } = e.target;
    setMetadata(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleProcess = async () => {
    if (!file) {
      setError('⚠️ 오디오 파일을 선택해주세요');
      return;
    }

    setProcessing(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('audio', file);
      formData.append('metadata', JSON.stringify(metadata));

      const response = await fetch(`${apiBaseUrl}/api/process-keynote`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      
      if (data.success) {
        setResult(data.data);
        await loadHistory(apiBaseUrl);
        alert('✓ 정리가 완료되었습니다!');
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      setError(`❌ 에러: ${err.message}`);
      console.error(err);
    } finally {
      setProcessing(false);
    }
  };

  const handleExport = async (resultId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/export/${resultId}`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Word 내보내기 실패');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GasTech_Insight_${resultId}.docx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(`내보내기 실패: ${err.message}`);
    }
  };

  const handleClearResult = () => {
    setResult(null);
    setFile(null);
    setFileName('');
    setMetadata({ speakerName: '', speakerTitle: '', date: '' });
    fileInputRef.current.value = '';
  };

  const handleViewResult = async (resultId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/results/${resultId}`);
      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(`결과 로드 실패: ${err.message}`);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>🎤 GasTech 2026 - Keynote Insight Organizer</h1>
          <p>Powered by Google Gemini & Cloud Speech-to-Text</p>
        </div>
      </header>

      <main className="container">
        {error && (
          <div className="error-box">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {result ? (
          <section className="result-section">
            <h2>✓ 정리 완료</h2>
            
            <div className="result-card">
              <div className="result-header">
                <div>
                  <h3>{result.filename}</h3>
                  <p className="timestamp">{new Date(result.processedAt).toLocaleString('ko-KR')}</p>
                </div>
                <div className="button-group">
                  <button 
                    className="btn btn-primary"
                    onClick={() => handleExport(result.id)}
                  >
                    📄 Word 다운로드
                  </button>
                  <button 
                    className="btn btn-secondary"
                    onClick={handleClearResult}
                  >
                    새로 시작
                  </button>
                </div>
              </div>

              <div className="result-content">
                <h4>【 정리 내용 】</h4>
                <div className="insight-text">
                  {result.insight.split('\n').map((line, idx) => (
                    <p key={idx}>{line || '\u00A0'}</p>
                  ))}
                </div>
              </div>

              <details className="transcript-section">
                <summary>📋 원본 음성 텍스트</summary>
                <div className="transcript-text">
                  <p>{result.transcript}</p>
                </div>
              </details>
            </div>

            {history.length > 0 && (
              <div className="history-section">
                <h3>📚 이전 정리 목록</h3>
                <div className="history-list">
                  {history.map(item => (
                    <div key={item.id} className="history-item">
                      <div>
                        <span>{item.filename}</span>
                        <small>{new Date(item.processedAt).toLocaleString('ko-KR')}</small>
                      </div>
                      <button 
                        className="btn-small"
                        onClick={() => handleViewResult(item.id)}
                      >
                        보기
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="upload-section">
            <h2>1️⃣ 오디오 파일 선택</h2>
            
            <div className="upload-box">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleFileSelect}
                className="file-input"
                id="audioFile"
              />
              <label htmlFor="audioFile" className="file-label">
                <div className="upload-icon">🎵</div>
                <span>오디오 파일을 선택하거나 드래그하세요</span>
                <small>MP3, WAV, M4A, WebM 등 지원</small>
              </label>
              {fileName && (
                <div className="file-selected">
                  <span>✓ {fileName}</span>
                </div>
              )}
            </div>

            <h2 style={{ marginTop: '2rem' }}>2️⃣ 연사 정보 입력 (선택사항)</h2>
            
            <div className="form-group">
              <input
                type="text"
                name="speakerName"
                placeholder="연사명 (예: Chris Wright)"
                value={metadata.speakerName}
                onChange={handleMetadataChange}
              />
              <input
                type="text"
                name="speakerTitle"
                placeholder="직책/직위 (예: 미국 에너지부 장관)"
                value={metadata.speakerTitle}
                onChange={handleMetadataChange}
              />
              <input
                type="datetime-local"
                name="date"
                value={metadata.date}
                onChange={handleMetadataChange}
              />
            </div>

            <h2 style={{ marginTop: '2rem' }}>3️⃣ 처리 시작</h2>
            
            <button
              className={`btn btn-process ${processing ? 'loading' : ''}`}
              onClick={handleProcess}
              disabled={!file || processing}
            >
              {processing ? (
                <>
                  <span className="spinner"></span>
                  처리 중... (음성 인식 + AI 정리)
                </>
              ) : (
                '▶ 정리 시작'
              )}
            </button>

            {processing && (
              <div className="processing-info">
                <p>⏳ 처리 중...</p>
                <p>1. Google Speech-to-Text로 음성을 텍스트로 변환 중</p>
                <p>2. Google Gemini로 양식에 맞게 정리 중</p>
                <p>파일 크기에 따라 1~5분 소요될 수 있습니다.</p>
              </div>
            )}

            {history.length > 0 && (
              <div className="history-section" style={{ marginTop: '2rem' }}>
                <h3>📚 최근 정리 목록</h3>
                <div className="history-list">
                  {history.slice(0, 5).map(item => (
                    <div key={item.id} className="history-item">
                      <div>
                        <span>{item.filename}</span>
                        <small>{new Date(item.processedAt).toLocaleString('ko-KR')}</small>
                      </div>
                      <button 
                        className="btn-small"
                        onClick={() => handleViewResult(item.id)}
                      >
                        보기
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>🔒 결과물은 안전하게 클라우드에 저장됩니다 | 언제든 접속 가능</p>
        <p>API 제공: Google Gemini API + Cloud Speech-to-Text</p>
      </footer>
    </div>
  );
}

export default App;
