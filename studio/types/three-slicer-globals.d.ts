interface LevoVector3 {
  x: number;
  y: number;
  z: number;
}

interface LevoSceneSnapshot {
  id: number;
  name: string;
  localPos: Float32Array;
  pos: LevoVector3;
  rot: LevoVector3;
  scale: LevoVector3;
}

interface LevoViewportApi {
  sceneSnapshot(): LevoSceneSnapshot[];
  placeObjectOnPlate(id: number, plateIndex: number, offsetX: number, offsetY: number): void;
  frame(): void;
}

interface Window {
  __vpApi?: () => LevoViewportApi | null | undefined;
}
