import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';

/**
 * Leitor por coletor/pistola (modo teclado HID): caracteres digitados muito rápido seguidos de Enter
 * são tratados como leitura de código, mesmo sem o campo de busca em foco.
 */
export function useHidScanner(onScan: (code: string) => void, enabled = true) {
  const buf = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // Campos de texto já recebem a leitura normalmente (tratada pelo próprio campo).
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const nowT = performance.now();
      if (nowT - last.current > 60) buf.current = '';
      last.current = nowT;
      if (e.key === 'Enter') {
        if (buf.current.length >= 4) { e.preventDefault(); cb.current(buf.current); }
        buf.current = '';
      } else if (e.key.length === 1) buf.current += e.key;
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [enabled]);
}

const cameraSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Botão que abre a câmera para ler código de barras (EAN, UPC, Code128, QR…). */
export function CameraButton({ onScan, continuous, label = 'Câmera' }: { onScan: (code: string) => void; continuous?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!cameraSupported()) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} aria-label="Ler código com a câmera"><CamIcon /> {label}</button>
      {open && <CameraModal continuous={continuous} onClose={() => setOpen(false)} onScan={(c) => { onScan(c); if (!continuous) setOpen(false); }} />}
    </>
  );
}

const CamIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M18 8v8" /></svg>
);

function CameraModal({ onScan, onClose, continuous }: { onScan: (c: string) => void; onClose: () => void; continuous?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    const recent = new Map<string, number>();
    const emit = (code: string) => {
      const t = Date.now();
      // Evita repetir o mesmo código enquanto ele continua na frente da câmera.
      if ((recent.get(code) ?? 0) > t - 1500) return;
      recent.set(code, t);
      setLastCode(code);
      if ('vibrate' in navigator) navigator.vibrate?.(60);
      cb.current(code);
    };
    (async () => {
      try {
        const Native = (window as any).BarcodeDetector;
        if (Native) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
          video.current!.srcObject = stream;
          await video.current!.play();
          const det = new Native({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] });
          let raf = 0;
          const loop = async () => {
            if (cancelled) return;
            try { const r = await det.detect(video.current!); if (r[0]?.rawValue) emit(r[0].rawValue); } catch { /* quadro inválido */ }
            raf = window.setTimeout(loop, 150) as unknown as number;
          };
          loop();
          stop = () => { clearTimeout(raf); stream.getTracks().forEach((t) => t.stop()); };
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video.current!, (res) => { if (res) emit(res.getText()); });
          if (cancelled) controls.stop();
          stop = () => controls.stop();
        }
      } catch (e: any) {
        setError(e?.name === 'NotAllowedError' ? 'Permissão da câmera negada. Libere o acesso nas configurações do navegador.' :
          !window.isSecureContext ? 'A câmera só funciona com o sistema aberto em HTTPS.' : 'Não foi possível abrir a câmera.');
      }
    })();
    return () => { cancelled = true; stop(); };
  }, []);
  return (
    <Modal title="Ler código de barras" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>{continuous ? 'Concluir' : 'Cancelar'}</button>}>
      {error ? <div className="notice danger">{error}</div> : (
        <div className="scanner-view">
          <video ref={video} playsInline muted />
          <div className="scanner-frame" />
        </div>
      )}
      <div className="faint" style={{ textAlign: 'center' }}>{lastCode ? `Último código lido: ${lastCode}` : 'Aponte a câmera para o código de barras.'}</div>
    </Modal>
  );
}
