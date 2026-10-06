import {useEffect, useMemo, useRef, useState} from "react";
import {factsWithPeople, type PeopleAssignment} from "@fotoro/contracts/people";
import {type LocalPhoto, LocalResources} from "../local/resources";
import {useLocalThumbnail} from "../local/useLocalThumbnail";
import {useDialogFocus} from "../library/dialog-focus";
import {Icon} from "../library/icons";
import {PeopleEngine} from "./engine";
import {assignmentsForCorrection, groupPeopleFaces, peopleSourceCurrent, type PeopleFace, type PersonGroup} from "./groups";
import {scanPeoplePhotos} from "./scan";
export interface PeopleUpdate {photo: LocalPhoto; assignments: PeopleAssignment[]}

function FaceThumbnail({face,photo,resources,onOpen}: {face: PeopleFace;photo: LocalPhoto;resources: LocalResources;onOpen:()=>void}) {
  const button=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=> {
    const element=button.current;if(!element)return;
    const observer=new IntersectionObserver(entries=>setVisible(entries[0].isIntersecting),{root:element.closest(".people-sheet"),rootMargin:"200px"});
    observer.observe(element);return()=>observer.disconnect();
  },[]);
  const {url,error}=useLocalThumbnail(photo,resources,()=>{},visible), [x,y,width,height]=face.box;
  return <button ref={button} className="people-face" aria-label={"Open "+photo.filename} onClick={onOpen}>
    {url ? <img src={url} alt="" style={{width:`${10000/width*100}%`,height:`${10000/height*100}%`,left:`${-x/width*100}%`,top:`${-y/height*100}%`}} /> : <span>{error?"Unavailable":"…"}</span>}
  </button>;
}
function GroupControls({group,groups,busy,onName,onMerge}: {group:PersonGroup;groups:PersonGroup[];busy:boolean;onName:(name:string)=>void;onMerge:(target:string)=>void}) {
  const [name,setName]=useState(group.name??""),[target,setTarget]=useState("");
  useEffect(()=>setName(group.name??""),[group.name]);
  return <div className="people-group-controls"><form onSubmit={event=>{event.preventDefault();onName(name);}}>
    <label><span className="visually-hidden">Person name</span><input aria-label="Person name" value={name} maxLength={160} disabled={busy} placeholder="Name" onChange={event=>setName(event.target.value)} /></label>
    <button disabled={busy || !name.trim() || Array.from(name).length>80}>Save name</button>
  </form>{groups.length>1 && <div><select aria-label="Merge with person" disabled={busy} value={target} onChange={event=>setTarget(event.target.value)}>
    <option value="">Merge with…</option>{groups.filter(other=>other.id!==group.id).map(other=><option key={other.id} value={other.id}>{other.name??`Group ${groups.indexOf(other)+1}`}</option>)}
  </select><button disabled={busy||!target} onClick={()=>onMerge(target)}>Merge</button></div>}</div>;
}
export function People({photos,resources,savedResources,onClose,onOpen,onAssignments}: {
  photos:LocalPhoto[];resources:LocalResources;savedResources?:LocalResources;onClose:()=>void;onOpen:(id:string)=>void;
  onAssignments?:(updates:PeopleUpdate[])=>Promise<void>;
}) {
  const panel=useRef<HTMLElement>(null),latest=useRef(photos),alive=useRef(false),operation=useRef<AbortController|undefined>(undefined);
  latest.current=photos;
  const [engine]=useState(()=>new PeopleEngine()),[faces,setFaces]=useState<PeopleFace[]>([]),[groups,setGroups]=useState<PersonGroup[]>([]);
  const [busy,setBusy]=useState(false),[correcting,setCorrecting]=useState(false),[status,setStatus]=useState(""),[assessed,setAssessed]=useState(false);
  const currentFaces=useRef(faces);currentFaces.current=faces;
  const currentClose=useRef(onClose);currentClose.current=onClose;
  const scanned=useRef(new Map<string,LocalPhoto>());
  useDialogFocus(panel,onClose);
  useEffect(()=> {alive.current=true;return()=> {alive.current=false;operation.current?.abort();engine.clear();for(const face of currentFaces.current)face.vector.fill(0);};},[engine]);
  useEffect(()=> {
    const clear=()=> {
      operation.current?.abort();engine.clear();for(const face of currentFaces.current)face.vector.fill(0);
      setFaces([]);setGroups([]);setAssessed(false);currentClose.current();
    };
    const hide=()=> {if(document.visibilityState==="hidden")clear();};
    window.addEventListener("pagehide",clear);window.addEventListener("fotoro-lock",clear);document.addEventListener("visibilitychange",hide);
    return()=> {window.removeEventListener("pagehide",clear);window.removeEventListener("fotoro-lock",clear);document.removeEventListener("visibilitychange",hide);};
  },[engine]);
  const currentPhotos=useMemo(()=>new Map(photos.map(photo=>[photo.id,photo])),[photos]);
  const visibleFaces=useMemo(()=>faces.filter(face=>peopleSourceCurrent(scanned.current.get(face.photoID)!,currentPhotos.get(face.photoID))),[faces,currentPhotos]);
  const byFace=useMemo(()=>new Map(visibleFaces.map(face=>[face.id,face])),[visibleFaces]);
  const visibleGroups=useMemo(()=>groups.map(group=>({...group,faceIDs:group.faceIDs.filter(id=>byFace.has(id))})).filter(group=>group.faceIDs.length),[groups,byFace]);
  useEffect(()=> {
    if (!correcting && faces.some(face=>!peopleSourceCurrent(scanned.current.get(face.photoID)!,currentPhotos.get(face.photoID)))) {
      operation.current?.abort();engine.clear();
      for (const face of faces) if(!byFace.has(face.id))face.vector.fill(0);
      setFaces(visibleFaces);setGroups(visibleGroups);
    }
  },[currentPhotos,faces,byFace,visibleFaces,visibleGroups,engine,correcting]);
  const start=async()=> {
    if(busy||correcting)return;
    const originals=latest.current.filter(photo=>photo.digest&&photo.current?.()!==false);
    if(originals.length>500){setStatus("Choose up to 500 photos to find people.");return;}
    operation.current?.abort();const controller=new AbortController();operation.current=controller;
    setBusy(true);setStatus("Downloading People models…");
    try {
      const {faces:detected,sources,skipped}=await scanPeoplePhotos(originals,controller.signal,{
        current:photo=>peopleSourceCurrent(photo,latest.current.find(value=>value.id===photo.id)),
        preview:async photo=>{
          const manager=photo.id.startsWith("saved:")?savedResources??resources:resources;
          return (await manager.load(photo,"preview",controller.signal)).blob;
        },analyze:blob=>engine.analyze(blob,controller.signal),progress:(completed,total)=>setStatus(`Finding people · ${completed} of ${total}`),
      });
      if(!alive.current||controller.signal.aborted){for(const face of detected)face.vector.fill(0);return;}
      const current=detected.filter(face=>peopleSourceCurrent(sources.get(face.photoID)!,latest.current.find(photo=>photo.id===face.photoID)));
      for(const face of faces)face.vector.fill(0);scanned.current=sources;setFaces(current);setGroups(groupPeopleFaces(current,latest.current));setAssessed(true);
      setStatus(skipped?`${skipped} photos could not be assessed. You can try again.`:current.length?"Groups are suggestions. Review before naming.":"No faces found.");
    }catch(error){if(alive.current)setStatus(controller.signal.aborted?"Finding people cancelled.":error instanceof Error?error.message:"People are unavailable. Try again.");}
    finally {engine.clear();if(alive.current)setBusy(false);}
  };
  const correct=async(previous:PersonGroup[],next:PersonGroup[])=> {
    if(busy||correcting||!alive.current)return;
    const updated=groups.flatMap(group=>!previous.some(value=>value.id===group.id)?[group]:group.id===previous[0]?.id?next:[]);
    try {
      const updates=assignmentsForCorrection(latest.current,visibleFaces,previous,next);
      for(const update of updates) {
        if(!peopleSourceCurrent(scanned.current.get(update.photo.id)!,update.photo))throw new Error("Photo source changed. Find people again.");
        factsWithPeople(update.photo.facts,update.photo.digest!,update.assignments);
      }
      setCorrecting(true);
      if(onAssignments)await onAssignments(updates);
      // The encrypted write and parent snapshot can settle before this component
      // receives the new photo props. Keep the correction fenced while React catches up.
      if(onAssignments)for(let attempt=0;attempt<60&&alive.current;attempt++) {
        if(updates.every(update=>peopleSourceCurrent(update.photo,latest.current.find(photo=>photo.id===update.photo.id),true)))break;
        await new Promise(resolve=>setTimeout(resolve,16));
      }
      if(!alive.current)return;
      if(updates.some(update=>!peopleSourceCurrent(update.photo,latest.current.find(photo=>photo.id===update.photo.id),!!onAssignments)))throw new Error("Photo source changed. Find people again.");
      // An owned edit replaces the catalog snapshot, including untouched photos.
      // Rebase only immutable sources that still match and are currently available.
      for(const [id,source] of scanned.current) {
        const current=latest.current.find(photo=>photo.id===id);
        if(peopleSourceCurrent(source,current,!!onAssignments))scanned.current.set(id,current!);
      }
      // The source map is a ref; invalidate the derived visible-face memo after rebasing.
      setFaces(current=>[...current]);
      setGroups(updated);setStatus(onAssignments?"People names updated.":"People names updated for this session.");
    }catch(error){if(alive.current)setStatus(error instanceof Error?error.message:"People names could not be updated.");}
    finally{if(alive.current)setCorrecting(false);}
  };
  return <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="People" className="sheet people-sheet">
    <div className="places-header"><div><h2>People</h2><p className="hint">Photos and face vectors stay on this device.</p></div><button aria-label="Close people" onClick={onClose}><Icon kind="close"/></button></div>
    {!assessed&&<p className="hint">Download face models and runtime to find faces. Groups may need corrections.</p>}
    <div className="actions"><button disabled={busy||correcting||!photos.length} onClick={()=>void start()}>{assessed?"Find people again":"Find people on this device"}</button>{busy&&<button onClick={()=>operation.current?.abort()}>Cancel</button>}</div>
    {status&&<p role="status" className="hint">{status}</p>}
    {visibleGroups.map((group,index)=><section key={group.id} className="people-group">
      <h3>{group.name??`Group ${index+1}`} <small>{new Set(group.faceIDs.map(id=>byFace.get(id)!.photoID)).size} photos</small></h3>
      <GroupControls group={group} groups={visibleGroups} busy={busy||correcting} onName={name=>void correct([group],[{...group,name}])} onMerge={target=> {
        const other=visibleGroups.find(value=>value.id===target);if(other)void correct([group,other],[{...other,name:other.name??group.name,faceIDs:[...other.faceIDs,...group.faceIDs]}]);
      }}/>
      <div className="people-faces">{group.faceIDs.map(id=>{const face=byFace.get(id)!,photo=currentPhotos.get(face.photoID)!;return <div key={id}>
        <FaceThumbnail face={face} photo={photo} resources={photo.id.startsWith("saved:")?savedResources??resources:resources} onOpen={()=>onOpen(photo.id)}/>
        <div>{group.faceIDs.length>1&&<button disabled={busy||correcting} onClick={()=>void correct([group],[{...group,faceIDs:group.faceIDs.filter(value=>value!==id)},{id:crypto.randomUUID(),faceIDs:[id]}])}>Separate</button>}
        <button disabled={busy||correcting} onClick={()=>void correct([group],[{...group,faceIDs:group.faceIDs.filter(value=>value!==id)}])}>Not a face</button></div>
      </div>;})}</div>
    </section>)}
    <details className="people-model-notices"><summary>Models and licenses</summary><p>YuNet face detection · MIT. SFace face recognition · Apache 2.0.</p><a href={new URL("./licenses/YuNet-LICENSE.txt",import.meta.url).href} target="_blank" rel="noreferrer">YuNet license</a>{" · "}<a href={new URL("./licenses/SFace-LICENSE.txt",import.meta.url).href} target="_blank" rel="noreferrer">SFace license</a></details>
  </aside>;
}
