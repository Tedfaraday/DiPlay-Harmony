export class ReconnectPolicy {
  attempts:number=0;private stopped:boolean=false;
  reset():void{this.attempts=0;this.stopped=false;}
  cancel():void{this.stopped=true;}
  connected():void{this.attempts=0;}
  next(enabled:boolean,foreground:boolean,credentials:boolean):number{
    if(this.stopped||!enabled||!foreground||!credentials||this.attempts>=3){return -1;}
    return [2000,4000,8000][this.attempts++];
  }
}
