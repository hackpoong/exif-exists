import React, { useState, useRef, useEffect } from 'react';
import { Upload, Download, Save, RefreshCw, FileImage, AlertCircle, CheckCircle, Info, ArrowRight } from 'lucide-react';

// Piexifjs library for JPG handling (loaded via CDN logic wrapper or direct implementation logic if needed, 
// but for simplicity in React single file, we load it dynamically or use a lighter approach).
// We will use a script tag injection for piexifjs to handle JPG complex exif structures easily.

const LoadScripts = () => {
  useEffect(() => {
    if (!window.piexif) {
      const script = document.createElement('script');
      script.src = "https://unpkg.com/piexifjs@1.0.6/piexif.js";
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);
  return null;
};

// --- PNG Helpers (Binary Manipulation for Stable Diffusion Parameters) ---

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = crcTable[(c ^ buf[n]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// Extract 'parameters' text chunk from PNG (Standard for SD/Reforge)
async function extractPngMetadata(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const textDecoder = new TextDecoder('utf-8'); // often latin1, but try utf-8
  
  // Validate PNG signature
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error("유효한 PNG 파일이 아닙니다.");
  }

  let offset = 8;
  let parameters = null;

  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = textDecoder.decode(new Uint8Array(buffer, offset + 4, 4));
    
    if (type === 'tEXt') {
      const chunkData = new Uint8Array(buffer, offset + 8, length);
      // Split keyword and text by null separator
      let nullIndex = -1;
      for (let i = 0; i < length; i++) {
        if (chunkData[i] === 0) {
          nullIndex = i;
          break;
        }
      }
      
      if (nullIndex > -1) {
        const keyword = textDecoder.decode(chunkData.slice(0, nullIndex));
        if (keyword === 'parameters') {
            const text = textDecoder.decode(chunkData.slice(nullIndex + 1));
            parameters = text;
            break; // Found it
        }
      }
    }
    
    offset += 12 + length; // Length(4) + Type(4) + Data(length) + CRC(4)
  }

  return parameters ? { type: 'png', data: parameters } : null;
}

// Inject 'parameters' chunk into PNG
async function injectPngMetadata(file, metadataString) {
  const originalBuffer = await file.arrayBuffer();
  const keyword = "parameters";
  
  // Create the chunk data: keyword + null separator + text
  const encoder = new TextEncoder();
  const keyData = encoder.encode(keyword);
  const textData = encoder.encode(metadataString);
  
  const chunkLength = keyData.length + 1 + textData.length;
  const chunkBuffer = new Uint8Array(chunkLength + 12); // Length(4) + Type(4) + Data + CRC(4)
  const view = new DataView(chunkBuffer.buffer);

  // 1. Length
  view.setUint32(0, chunkLength);
  
  // 2. Type
  writeString(view, 4, "tEXt");
  
  // 3. Data
  chunkBuffer.set(keyData, 8);
  chunkBuffer[8 + keyData.length] = 0; // Null separator
  chunkBuffer.set(textData, 8 + keyData.length + 1);
  
  // 4. CRC (Calculate on Type + Data)
  const crcInput = chunkBuffer.slice(4, 8 + chunkLength);
  view.setUint32(8 + chunkLength, crc32(crcInput));

  // Combine: Signature + New Chunk + Original Data (minus signature)
  // Note: Simple prepend after signature. More robust would be to insert before IDAT, but this usually works for SD readers.
  const finalBuffer = new Uint8Array(originalBuffer.byteLength + chunkBuffer.length);
  finalBuffer.set(new Uint8Array(originalBuffer.slice(0, 8)), 0); // Signature
  finalBuffer.set(chunkBuffer, 8); // New Metadata Chunk
  finalBuffer.set(new Uint8Array(originalBuffer.slice(8)), 8 + chunkBuffer.length); // Rest of file

  return new Blob([finalBuffer], { type: 'image/png' });
}


// --- JPG Helpers (using window.piexif) ---

async function extractJpgMetadata(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const exifObj = window.piexif.load(e.target.result);
        resolve({ type: 'jpg', data: exifObj });
      } catch (err) {
        resolve(null); // No EXIF or parse error
      }
    };
    reader.readAsDataURL(file);
  });
}

async function injectJpgMetadata(file, metadataObj) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const exifStr = window.piexif.dump(metadataObj);
        const inserted = window.piexif.insert(exifStr, e.target.result);
        
        // Convert DataURL back to Blob
        const byteString = atob(inserted.split(',')[1]);
        const mimeString = inserted.split(',')[0].split(':')[1].split(';')[0];
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: mimeString });
        resolve(blob);
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsDataURL(file);
  });
}

// --- Main App Component ---

export default function ExifPreserverApp() {
  const [cachedMetadata, setCachedMetadata] = useState(null);
  const [sourceFileName, setSourceFileName] = useState("");
  const [processedImage, setProcessedImage] = useState(null);
  const [status, setStatus] = useState({ type: 'idle', msg: '이미지 파일을 기다리는 중...' });
  const [dragActive, setDragActive] = useState(false);
  
  // App Logo (Now using the file in public folder)
  const appLogo = "/logo.jpg"; 

  // Step 1: Extract
  const handleExtract = async (file) => {
    setStatus({ type: 'loading', msg: '메타데이터 추출 중...' });
    setProcessedImage(null); // Reset step 2 result

    try {
      let result = null;
      if (file.type === 'image/png') {
        result = await extractPngMetadata(file);
      } else if (file.type === 'image/jpeg') {
        if (!window.piexif) throw new Error("JPG 라이브러리 로딩 중... 잠시 후 다시 시도해주세요.");
        result = await extractJpgMetadata(file);
      } else if (file.type === 'image/webp') {
        // WebP simple support warning
        setStatus({ type: 'error', msg: "WebP는 현재 실험적 지원입니다. PNG 사용을 권장합니다." });
        return; 
      }

      if (result) {
        setCachedMetadata(result);
        setSourceFileName(file.name);
        setStatus({ type: 'success', msg: `[${file.name}]에서 메타데이터를 성공적으로 저장했습니다!` });
      } else {
        setStatus({ type: 'error', msg: '이 이미지에는 복구할 AI 메타데이터(parameters/EXIF)가 없습니다.' });
      }
    } catch (e) {
      console.error(e);
      setStatus({ type: 'error', msg: `오류 발생: ${e.message}` });
    }
  };

  // Step 2: Inject
  const handleInject = async (file) => {
    if (!cachedMetadata) {
      setStatus({ type: 'error', msg: '먼저 1단계에서 원본 메타데이터를 추출해주세요!' });
      return;
    }

    setStatus({ type: 'loading', msg: '메타데이터 주입 중...' });

    try {
      let finalBlob = null;

      // Handle Format Mismatch warnings
      if (file.type === 'image/png' && cachedMetadata.type !== 'png') {
        setStatus({ type: 'error', msg: '형식 불일치: PNG에는 PNG 메타데이터만 씌울 수 있습니다.' });
        return;
      }
      if (file.type === 'image/jpeg' && cachedMetadata.type !== 'jpg') {
        setStatus({ type: 'error', msg: '형식 불일치: JPG에는 JPG 메타데이터만 씌울 수 있습니다.' });
        return;
      }

      if (file.type === 'image/png') {
        finalBlob = await injectPngMetadata(file, cachedMetadata.data);
      } else if (file.type === 'image/jpeg') {
        finalBlob = await injectJpgMetadata(file, cachedMetadata.data);
      }

      if (finalBlob) {
        const url = URL.createObjectURL(finalBlob);
        setProcessedImage({ url, name: `fixed_${file.name}` });
        setStatus({ type: 'success', msg: '메타데이터 복구 완료! 아래에서 다운로드하세요.' });
      }
    } catch (e) {
      console.error(e);
      setStatus({ type: 'error', msg: `주입 실패: ${e.message}` });
    }
  };

  const handleDrop = (e, step) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (step === 1) handleExtract(file);
      if (step === 2) handleInject(file);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-sans selection:bg-green-500 selection:text-white flex flex-col">
      <LoadScripts />
      
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 p-4 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="w-12 h-12 bg-green-600 rounded-lg flex items-center justify-center overflow-hidden shadow-inner shrink-0">
                {/* Fallback to text if image fails loading, but using the uploaded file path */}
                <img src={appLogo} alt="Logo" className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
                <span className="font-bold text-xs text-white absolute" style={{display: 'none'}}>EXIF</span>
            </div>
            <div>
                <h1 className="text-2xl font-bold text-green-400 tracking-tight">EXIF 있음</h1>
                <p className="text-gray-400 text-sm hidden sm:block">AI 이미지 메타데이터 보존 및 복구 도구</p>
            </div>
            
            {/* Added: Creator Info */}
            <div className="ml-auto text-sm text-gray-400 font-medium">
              제작자 : 아카라이브 근첩A
            </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-6 space-y-8 flex-1 w-full">
        
        {/* Status Bar */}
        <div className={`p-4 rounded-lg border flex items-center gap-3 transition-colors ${
          status.type === 'error' ? 'bg-red-900/30 border-red-700 text-red-200' :
          status.type === 'success' ? 'bg-green-900/30 border-green-700 text-green-200' :
          'bg-gray-800 border-gray-700 text-gray-300'
        }`}>
          {status.type === 'error' ? <AlertCircle size={20} /> : 
           status.type === 'success' ? <CheckCircle size={20} /> : 
           <Info size={20} />}
          <span className="font-medium">{status.msg}</span>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
            
            {/* Step 1: Source */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="bg-gray-700 w-8 h-8 rounded-full flex items-center justify-center text-sm">1</span>
                        원본 불러오기
                    </h2>
                    {cachedMetadata && <span className="text-xs bg-green-900 text-green-300 px-2 py-1 rounded">데이터 확보됨</span>}
                </div>
                
                <div 
                    className={`border-2 border-dashed rounded-xl h-64 flex flex-col items-center justify-center p-6 text-center transition-all cursor-pointer group
                    ${cachedMetadata ? 'border-green-500/50 bg-green-900/10' : 'border-gray-600 hover:border-green-500 hover:bg-gray-800'}`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={(e) => handleDrop(e, 1)}
                    onClick={() => document.getElementById('file-upload-1').click()}
                >
                    <input type="file" id="file-upload-1" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files[0] && handleExtract(e.target.files[0])} />
                    
                    {cachedMetadata ? (
                        <div className="space-y-3">
                            <FileImage size={48} className="mx-auto text-green-400" />
                            <div>
                                <p className="font-bold text-green-400">{sourceFileName}</p>
                                <p className="text-sm text-gray-400">메타데이터 캐시 저장 완료</p>
                            </div>
                            <div className="text-xs text-gray-500 bg-gray-900 p-2 rounded max-h-24 overflow-hidden text-left break-all opacity-70">
                                {cachedMetadata.type === 'png' ? cachedMetadata.data.substring(0, 100) + "..." : "EXIF Data Cached"}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3 group-hover:scale-105 transition-transform">
                            <Save size={48} className="mx-auto text-gray-500 group-hover:text-green-400" />
                            <div>
                                <p className="font-medium text-gray-300">원본(프롬프트 있는) 사진을</p>
                                <p className="text-sm text-gray-500">여기에 드래그하거나 클릭하세요</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Step 2: Target */}
            <div className="space-y-4">
                 <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="bg-gray-700 w-8 h-8 rounded-full flex items-center justify-center text-sm">2</span>
                        수정본 덮어쓰기
                    </h2>
                </div>

                <div 
                    className={`border-2 border-dashed rounded-xl h-64 flex flex-col items-center justify-center p-6 text-center transition-all cursor-pointer group relative overflow-hidden
                    ${!cachedMetadata ? 'opacity-50 pointer-events-none border-gray-700' : 'border-gray-600 hover:border-blue-500 hover:bg-gray-800'}`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={(e) => handleDrop(e, 2)}
                    onClick={() => cachedMetadata && document.getElementById('file-upload-2').click()}
                >
                    <input type="file" id="file-upload-2" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files[0] && handleInject(e.target.files[0])} />
                    
                    {processedImage ? (
                        <div className="relative w-full h-full flex flex-col items-center justify-center z-10">
                             {/* Image moved to background explicitly and before the overlay content */}
                            <img src={processedImage.url} className="absolute inset-0 w-full h-full object-contain opacity-50 blur-sm" alt="result" />
                            
                            {/* Overlay and Buttons now have higher z-index (z-20) and are rendered after the image */}
                            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center space-y-4 z-20">
                                <CheckCircle size={48} className="text-green-400" />
                                <a 
                                    href={processedImage.url} 
                                    download={processedImage.name}
                                    className="bg-green-600 hover:bg-green-500 text-white px-6 py-3 rounded-full font-bold flex items-center gap-2 shadow-lg transition-transform hover:scale-105 cursor-pointer"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Download size={18} />
                                    저장하기
                                </a>
                                <button 
                                    className="text-sm text-gray-400 hover:text-white underline cursor-pointer"
                                    onClick={(e) => { e.stopPropagation(); setProcessedImage(null); }}
                                >
                                    다른 파일 작업하기
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3 group-hover:scale-105 transition-transform">
                            <RefreshCw size={48} className="mx-auto text-gray-500 group-hover:text-blue-400" />
                            <div>
                                <p className="font-medium text-gray-300">수정된(메타데이터 없는) 사진을</p>
                                <p className="text-sm text-gray-500">여기에 드래그하여 복구하세요</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

        </div>

        {/* Info Section - Revised for intuitive usage */}
        <div className="bg-gray-800 p-6 rounded-xl border border-gray-700">
            <h3 className="font-bold text-lg mb-4 text-green-400 flex items-center gap-2">
                <Info size={20} />
                사용 가이드
            </h3>
            <div className="grid md:grid-cols-3 gap-4 text-sm text-gray-300">
                <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-700 flex flex-col gap-2">
                    <span className="font-bold text-white flex items-center gap-2">
                        <span className="bg-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-xs">1</span>
                        원본 확보
                    </span>
                    <p>메타데이터(프롬프트)가 살아있는 <strong>원본 사진</strong>을 왼쪽 [1. 원본 불러오기] 칸에 드래그하여 정보를 복사해둡니다.</p>
                </div>
                 <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-700 flex flex-col gap-2">
                    <span className="font-bold text-white flex items-center gap-2">
                        <span className="bg-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-xs">2</span>
                        편집 및 수정
                    </span>
                    <p>포토샵이나 Reforge, 인페인팅 툴을 사용하여 이미지를 마음껏 수정합니다. (이 과정에서 메타데이터가 날아가도 괜찮습니다.)</p>
                </div>
                 <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-700 flex flex-col gap-2">
                    <span className="font-bold text-white flex items-center gap-2">
                        <span className="bg-gray-700 w-5 h-5 rounded-full flex items-center justify-center text-xs">3</span>
                        복구 완료
                    </span>
                    <p>수정이 끝난 파일을 오른쪽 [2. 수정본 덮어쓰기] 칸에 넣으면, 아까 복사해둔 정보를 다시 심어서 다운로드할 수 있습니다.</p>
                </div>
            </div>
            <p className="mt-4 text-xs text-gray-500 text-center">
                ※ 모든 과정은 서버 전송 없이 사용자의 브라우저 내부에서만 안전하게 처리됩니다.
            </p>
        </div>
      </div>

      {/* Footer - Special Thanks */}
      <footer className="bg-gray-900 border-t border-gray-800 p-6 text-center">
          <p className="text-gray-500 text-sm">
            Special thanks to{' '}
            <a href="https://arca.live/b/aiart" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-400 transition-colors font-medium hover:underline">AI그림챈</a>
            {' / '}
            <a href="https://arca.live/b/aiartreal" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-400 transition-colors font-medium hover:underline">AI반실사챈</a>
            {' / '}
            <a href="https://arca.live/b/characterai" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-400 transition-colors font-medium hover:underline">AI채팅챈</a>
          </p>
      </footer>
    </div>
  );
}