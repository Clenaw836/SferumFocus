import {useEffect, useRef, useState} from 'preact/hooks';
import {Sheet} from './Sheet';
import {requestMediaAccess, openMediaSettings, inMax} from '../lib/max';
import {checkpointTutor} from '../lib/tutorSync';
import {tutorSession} from '../lib/tutorSession';
/** Tracks exist only while this sheet is mounted. Gallery is a separate control. */
export function CameraCapture({onClose,onPhoto}:{onClose:()=>void;onPhoto:(file:File)=>void}) {
  const video=useRef<HTMLVideoElement>(null);
  const live=useRef(true), epoch=useRef(tutorSession.epoch);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  const [ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false, stream:MediaStream|null=null;
    const unsubscribe=tutorSession.subscribe(()=>{if(tutorSession.epoch!==epoch.current){cancelled=true;stream?.getTracks().forEach(t=>t.stop());closeRef.current();}});
    void (async()=>{
      try {
        await requestMediaAccess('camera',checkpointTutor);
        if(cancelled)return;
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
        if(cancelled){stream.getTracks().forEach(t=>t.stop());return;}
        if(video.current){video.current.srcObject=stream;await video.current.play();}
      }catch(e){if(!cancelled)setError(e instanceof Error && e.message.startsWith('Черновик') ? e.message : 'Камера недоступна. Можно выбрать готовое фото или продолжить текстом.');}
    })();
    return ()=>{live.current=false;cancelled=true;unsubscribe();stream?.getTracks().forEach(t=>t.stop());};
  },[]);
  const capture=()=>{
    const v=video.current;if(!v?.videoWidth)return;
    const scale=Math.min(1,1280/v.videoWidth), c=document.createElement('canvas');
    c.width=Math.round(v.videoWidth*scale);c.height=Math.round(v.videoHeight*scale);
    const ctx=c.getContext('2d');if(!ctx)return;ctx.drawImage(v,0,0,c.width,c.height);
    c.toBlob(blob=>{if(blob&&live.current&&tutorSession.epoch===epoch.current){onPhoto(new File([blob],'решение.jpg',{type:'image/jpeg'}));onClose();}},'image/jpeg',.85);
  };
  return <Sheet open title="Фото решения" onClose={onClose}>
    <p>Снимок останется вложением к вопросу. Отправка репетитору — только по кнопке «Отправить».</p>
    <video ref={video} class="tutor-camera l-blk b-box b-nob mt-3 mb-3 l-w100" autoPlay muted playsInline aria-label="Предпросмотр камеры" onLoadedData={()=>setReady(true)} />
    {error&&<p role="status">{error}</p>}
    {!error&&<button type="button" class="btn btn-primary" disabled={!ready} onClick={capture}>Сделать снимок</button>}
    {error&&inMax()&&<button type="button" class="btn btn-secondary" onClick={()=>void openMediaSettings().catch(()=>setError('Настройки недоступны. Вернись и выбери готовое фото.'))}>Настройки разрешений MAX</button>}
    <button type="button" class="btn btn-ghost" onClick={onClose}>Назад к вопросу</button>
  </Sheet>;
}
