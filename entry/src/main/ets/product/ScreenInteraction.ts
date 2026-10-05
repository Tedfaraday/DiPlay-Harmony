export class ScreenPoint {
  id:number;x:number;y:number;
  constructor(id:number,x:number,y:number){this.id=id;this.x=x;this.y=y;}
}
export class VideoViewport {
  left:number;top:number;width:number;height:number;
  constructor(left:number,top:number,width:number,height:number){this.left=left;this.top=top;this.width=width;this.height=height;}
  contains(point:ScreenPoint):boolean{return point.x>=this.left&&point.y>=this.top&&point.x<=this.left+this.width&&point.y<=this.top+this.height;}
}
export class ScreenReport {
  x:number;y:number;down:boolean;
  constructor(x:number,y:number,down:boolean){this.x=x;this.y=y;this.down=down;}
}
export class ScreenAction {showControls:boolean=false;reports:ScreenReport[]=[];}
// Owns one touch sequence. Multi-finger gestures stay on the tablet; normal
// single-finger input is mapped to the fitted video, excluding letterbox bars.
export class ScreenInteraction {
  private active:Map<number,ScreenPoint>=new Map();
  private origins:Map<number,ScreenPoint>=new Map();
  private multi:boolean=false;private invalid:boolean=false;private fired:boolean=false;private gestureAt:number=0;
  private pending:ScreenPoint|undefined;private latest:ScreenPoint|undefined;private pressed:ScreenReport|undefined;
  private pendingAt:number=0;private viewport:VideoViewport=new VideoViewport(0,0,1,1);
  private normalized(point:ScreenPoint,down:boolean):ScreenReport {
    return new ScreenReport(Math.max(0,Math.min(1,(point.x-this.viewport.left)/this.viewport.width)),
      Math.max(0,Math.min(1,(point.y-this.viewport.top)/this.viewport.height)),down);
  }
  private release(action:ScreenAction):void {
    if(this.pressed){const up=this.latest?this.normalized(this.latest,false):new ScreenReport(this.pressed.x,this.pressed.y,false);action.reports.push(up);this.pressed=undefined;}
  }
  cancel():ScreenAction {const action=new ScreenAction();this.release(action);this.clear();return action;}
  private clear():void{this.active.clear();this.origins.clear();this.multi=false;this.invalid=false;this.fired=false;this.pending=undefined;this.latest=undefined;this.pressed=undefined;}
  flush(now:number):ScreenAction {
    const action=new ScreenAction();if(this.pending&&this.active.size===1&&!this.multi&&now-this.pendingAt>=120){
      const down=this.normalized(this.pending,true);action.reports.push(down);this.pressed=down;this.pending=undefined;
      if(this.latest&&(down.x!==this.normalized(this.latest,true).x||down.y!==this.normalized(this.latest,true).y)){
        this.pressed=this.normalized(this.latest,true);action.reports.push(this.pressed);}
    }return action;
  }
  feed(kind:string,points:ScreenPoint[],changed:ScreenPoint[],now:number,immersive:boolean,viewport:VideoViewport):ScreenAction {
    if(kind==='cancel'){return this.cancel();}const action=new ScreenAction();this.viewport=viewport;
    for(const point of points){this.active.set(point.id,point);}
    for(const point of changed){if(kind==='up'){this.active.delete(point.id);}else{this.active.set(point.id,point);}}
    if(this.active.size>1){
      this.multi=true;this.pending=undefined;this.release(action);
      if(this.active.size>3){this.invalid=true;this.origins.clear();}
      if(immersive&&this.active.size===3&&!this.invalid){
        if(this.origins.size===0){this.gestureAt=now;this.active.forEach((point:ScreenPoint,id:number):void=>{this.origins.set(id,new ScreenPoint(id,point.x,point.y));});}
        if(!this.fired&&now-this.gestureAt<=1400){
          let down=true;this.origins.forEach((start:ScreenPoint,id:number):void=>{
            const current=this.active.get(id);if(!current){down=false;return;}
            const dy=current.y-start.y;if(dy<64||Math.abs(current.x-start.x)>Math.max(36,dy*0.7)){down=false;}
          });if(down){this.fired=true;action.showControls=true;}
        }
      }else if(this.origins.size>0){this.invalid=true;}
      return action;
    }
    if(this.active.size===0){
      if(!this.multi){if(changed.length>0){this.latest=changed[0];}
        if(this.pending){this.pressed=this.normalized(this.pending,true);action.reports.push(this.pressed);this.pending=undefined;}
        this.release(action);}
      this.clear();return action;
    }
    if(this.multi){this.invalid=true;return action;}
    const point=Array.from(this.active.values())[0];this.latest=point;
    if(kind==='down'&&viewport.contains(point)){
      if(immersive){this.pending=new ScreenPoint(point.id,point.x,point.y);this.pendingAt=now;}
      else{this.pressed=this.normalized(point,true);action.reports.push(this.pressed);}
    }else if(kind==='move'){
      const pending=this.flush(now);action.reports.push(...pending.reports);
      if(this.pressed&&pending.reports.length===0){this.pressed=this.normalized(point,true);action.reports.push(this.pressed);}
    }return action;
  }
}
