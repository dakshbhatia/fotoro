import * as ort from "onnxruntime-web/wasm";
import {preparePeopleModels} from "./models";
import {alignedFaceRGB, decodeYuNet, normalizedVector, quantizedBox} from "./geometry";
import {retryableSemanticModels} from "../local/semantic-config";
const prepare = retryableSemanticModels(async () => {
  const assets = await preparePeopleModels();
  ort.env.wasm.numThreads = 1; Object.assign(ort.env.wasm, assets.runtime);
  // The pinned SFace graph lists immutable weights as graph inputs (old ONNX exporter).
  // ORT supports it; keep production logs at errors instead of repeating a warning per weight.
  const options = {executionProviders: ["wasm"], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const};
  const detector = await ort.InferenceSession.create(assets.detector, options);
  try {return {detector, recognizer: await ort.InferenceSession.create(assets.recognizer, options)};}
  catch (error) {await detector.release(); throw error;}
});
let queue = Promise.resolve();
self.onmessage = event => {
  const message = event.data;
  queue = queue.then(async () => {
    let image: ImageBitmap | undefined;
    try {
      if (!(message.blob instanceof Blob) || message.blob.size > 10 * 1024 * 1024) throw new Error("People preview unavailable.");
      let models;
      try {
        if(typeof OffscreenCanvas==="undefined"||typeof createImageBitmap==="undefined")throw new Error("People unavailable.");
        models = await prepare();
      } catch {self.postMessage({id:message.id,error:true,runtimeUnavailable:true});return;}
      image = await createImageBitmap(message.blob);
      if (image.width > 1600 || image.height > 1600) throw new Error("People preview unavailable.");
      const source = new OffscreenCanvas(image.width, image.height), sourceContext = source.getContext("2d", {willReadFrequently:true});
      if (!sourceContext) throw new Error("People unavailable."); sourceContext.drawImage(image,0,0);
      const pixels = sourceContext.getImageData(0,0,image.width,image.height);
      const canvas = new OffscreenCanvas(640,640), context = canvas.getContext("2d", {willReadFrequently:true});
      if (!context) throw new Error("People unavailable.");
      const scale = Math.min(640/image.width,640/image.height), width = image.width * scale, height = image.height * scale;
      context.fillStyle = "black"; context.fillRect(0,0,640,640); context.drawImage(image,0,0,width,height);
      const rgba = context.getImageData(0,0,640,640).data, input = new Float32Array(3*640*640);
      for (let index = 0; index < 640*640; index++) for (let channel=0;channel<3;channel++) input[channel*640*640+index]=rgba[index*4+2-channel];
      const detectorInput = new ort.Tensor("float32",input,[1,3,640,640]);
      let result: ort.InferenceSession.OnnxValueMapType;
      try {result = await models.detector.run({input:detectorInput});} finally {detectorInput.dispose();}
      let detections;
      try {detections = decodeYuNet(Object.fromEntries(Object.entries(result).map(([name,tensor]) => [name,tensor.data as Float32Array])));}
      finally {for (const tensor of Object.values(result)) tensor.dispose();}
      const faces = [];
      for (const detection of detections) {
        const box = detection.box.map(value=>value/scale);
        if (box[0] >= image.width || box[1] >= image.height || box[0] + box[2] <= 0 || box[1] + box[3] <= 0) continue;
        const landmarks = detection.landmarks.map(point => [point[0]/scale,point[1]/scale] as const);
        const aligned = alignedFaceRGB(pixels.data,image.width,image.height,landmarks);
        const recognizerInput = new ort.Tensor("float32",aligned,[1,3,112,112]);
        let embeddings: ort.InferenceSession.OnnxValueMapType;
        try {embeddings = await models.recognizer.run({data:recognizerInput});} finally {recognizerInput.dispose();}
        let vector;
        try {vector = normalizedVector(embeddings.fc1.data as Float32Array);}
        finally {for (const tensor of Object.values(embeddings)) tensor.dispose();}
        faces.push({box:quantizedBox(box,image.width,image.height),vector,score:detection.score});
      }
      self.postMessage({id:message.id,faces});
    } catch {self.postMessage({id:message.id,error:true});}
    finally {image?.close();}
  });
};
