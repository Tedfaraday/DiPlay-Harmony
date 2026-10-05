#include <napi/native_api.h>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avformat.h>
#include <native_window/external_window.h>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>
#include <string>
void RegisterDiPlayAudio(napi_env env,napi_value exports);
void RegisterDiPlayMdns(napi_env env,napi_value exports);

namespace {
struct Packet { std::vector<uint8_t> bytes; uint32_t flags; int64_t pts; };
struct Input { uint32_t index; OH_AVBuffer *buffer; };
class Decoder {
public:
  std::atomic<int64_t> submitted{0}, rendered{0};
  std::atomic<int32_t> error{0}, actualWidth{0}, actualHeight{0};
  std::atomic<bool> running{false};
  std::mutex mutex; std::condition_variable ready;
  std::deque<Input> inputs; std::deque<Packet> packets;
  size_t queuedBytes=0; OH_AVCodec *codec=nullptr; OHNativeWindow *window=nullptr; std::thread worker;
  static void OnError(OH_AVCodec *, int32_t code, void *ctx) {
    auto *d=static_cast<Decoder *>(ctx); d->error=code;
    OH_LOG_Print(LOG_APP, LOG_ERROR, 0, "DiPlayVideo", "Decoder error %{public}d", code);
  }
  static void OnFormat(OH_AVCodec *, OH_AVFormat *format, void *ctx) {
    auto *d=static_cast<Decoder *>(ctx);int32_t width=0,height=0;
    if(OH_AVFormat_GetIntValue(format,OH_MD_KEY_WIDTH,&width)&&OH_AVFormat_GetIntValue(format,OH_MD_KEY_HEIGHT,&height)&&width>0&&height>0){
      d->actualWidth=width;d->actualHeight=height;
      OH_LOG_Print(LOG_APP,LOG_INFO,0,"DiPlayVideo","Decoded video format %{public}d x %{public}d",width,height);
    }
  }
  static void OnInput(OH_AVCodec *, uint32_t index, OH_AVBuffer *buffer, void *ctx) {
    auto *d=static_cast<Decoder *>(ctx); std::lock_guard<std::mutex> lock(d->mutex);
    if(d->running){d->inputs.push_back({index,buffer});d->ready.notify_one();}
  }
  static void OnOutput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *, void *ctx) {
    auto *d=static_cast<Decoder *>(ctx); if(!d->running){return;}
    const auto result=OH_VideoDecoder_RenderOutputBuffer(codec,index);
    if(result==AV_ERR_OK){if(++d->rendered==1){OH_LOG_Print(LOG_APP,LOG_INFO,0,"DiPlayVideo","First decoded frame rendered to surface");}}
    else{d->error=result;}
  }
  void Stop() {
    {std::lock_guard<std::mutex> lock(mutex);running=false;ready.notify_all();}
    if(worker.joinable()){worker.join();}
    if(codec){OH_VideoDecoder_Stop(codec);OH_VideoDecoder_Destroy(codec);codec=nullptr;}
    if(window){OH_NativeWindow_DestroyNativeWindow(window);window=nullptr;}
    std::lock_guard<std::mutex> lock(mutex);inputs.clear();packets.clear();queuedBytes=0;
  }
  int32_t Start(uint64_t id,int32_t width,int32_t height) {
    Stop();submitted=0;rendered=0;error=0;actualWidth=0;actualHeight=0;
    auto result=OH_NativeWindow_CreateNativeWindowFromSurfaceId(id,&window);
    if(result!=0||!window){error=result?result:-1;Stop();return error;}
    codec=OH_VideoDecoder_CreateByMime("video/avc");if(!codec){error=-2;Stop();return error;}
    OH_AVCodecCallback callback{OnError,OnFormat,OnInput,OnOutput};
    auto err=OH_VideoDecoder_RegisterCallback(codec,callback,this);
    OH_AVFormat *format=OH_AVFormat_Create();
    if(!format){error=-3;Stop();return error;}
    OH_AVFormat_SetIntValue(format,OH_MD_KEY_WIDTH,width);OH_AVFormat_SetIntValue(format,OH_MD_KEY_HEIGHT,height);
    OH_AVFormat_SetIntValue(format,OH_MD_KEY_MAX_INPUT_SIZE,8*1024*1024);
    if(err==AV_ERR_OK){err=OH_VideoDecoder_Configure(codec,format);}OH_AVFormat_Destroy(format);
    if(err==AV_ERR_OK){err=OH_VideoDecoder_SetSurface(codec,window);}
    if(err==AV_ERR_OK){err=OH_VideoDecoder_Prepare(codec);}
    if(err!=AV_ERR_OK){error=err;Stop();return err;}
    running=true;worker=std::thread([this]{Run();});err=OH_VideoDecoder_Start(codec);
    if(err!=AV_ERR_OK){error=err;Stop();return err;}
    OH_LOG_Print(LOG_APP,LOG_INFO,0,"DiPlayVideo","Native H.264 decoder started %{public}d x %{public}d",width,height);return 0;
  }
  void Run() {
    while(true){
      Input input{};Packet packet;
      {std::unique_lock<std::mutex> lock(mutex);ready.wait(lock,[this]{return !running||(!inputs.empty()&&!packets.empty());});
        if(!running){return;}input=inputs.front();inputs.pop_front();packet=std::move(packets.front());packets.pop_front();queuedBytes-=packet.bytes.size();}
      auto *address=OH_AVBuffer_GetAddr(input.buffer);const auto capacity=OH_AVBuffer_GetCapacity(input.buffer);
      if(!address||capacity<0||packet.bytes.size()>static_cast<size_t>(capacity)){error=-4;running=false;return;}
      std::memcpy(address,packet.bytes.data(),packet.bytes.size());
      OH_AVCodecBufferAttr attr{packet.pts,static_cast<int32_t>(packet.bytes.size()),0,packet.flags};
      auto err=OH_AVBuffer_SetBufferAttr(input.buffer,&attr);
      if(err==AV_ERR_OK){err=OH_VideoDecoder_PushInputBuffer(codec,input.index);}
      if(err!=AV_ERR_OK){error=err;running=false;return;}++submitted;
    }
  }
  bool Feed(const uint8_t *data,size_t size,uint32_t flags,int64_t pts) {
    std::lock_guard<std::mutex> lock(mutex);
    if(!running||error!=0||size==0||size>8*1024*1024||packets.size()>=16||queuedBytes+size>12*1024*1024){return false;}
    packets.push_back({std::vector<uint8_t>(data,data+size),flags,pts});queuedBytes+=size;ready.notify_one();return true;
  }
  ~Decoder(){Stop();}
};
Decoder decoder;
napi_value Start(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);int32_t width=0,height=0;size_t length=0;
  if(argc!=3||napi_get_value_string_utf8(env,args[0],nullptr,0,&length)!=napi_ok||length<1||length>20||
    napi_get_value_int32(env,args[1],&width)!=napi_ok||napi_get_value_int32(env,args[2],&height)!=napi_ok||width<16||height<16||width>4096||height>4096){napi_throw_type_error(env,nullptr,"Invalid decoder arguments");return nullptr;}
  std::string id(length+1,'\0');napi_get_value_string_utf8(env,args[0],id.data(),id.size(),&length);id.resize(length);
  if(id.find_first_not_of("0123456789")!=std::string::npos){napi_throw_type_error(env,nullptr,"Invalid surface identifier");return nullptr;}
  uint64_t surface=0;try{surface=std::stoull(id);}catch(...){napi_throw_type_error(env,nullptr,"Invalid surface identifier");return nullptr;}
  napi_value result;napi_create_int32(env,decoder.Start(surface,width,height),&result);return result;
}
napi_value Feed(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);void *data=nullptr;size_t size=0;uint32_t flags=0;int64_t pts=0;
  if(argc!=3||napi_get_arraybuffer_info(env,args[0],&data,&size)!=napi_ok||napi_get_value_uint32(env,args[1],&flags)!=napi_ok||
     napi_get_value_int64(env,args[2],&pts)!=napi_ok||(flags!=0&&flags!=AVCODEC_BUFFER_FLAGS_CODEC_DATA)){napi_throw_type_error(env,nullptr,"Invalid decoder packet");return nullptr;}
  napi_value result;napi_get_boolean(env,decoder.Feed(static_cast<uint8_t *>(data),size,flags,pts),&result);return result;
}
napi_value Stop(napi_env env,napi_callback_info){decoder.Stop();napi_value result;napi_get_undefined(env,&result);return result;}
napi_value Stats(napi_env env,napi_callback_info){
  int64_t queued=0;{std::lock_guard<std::mutex> lock(decoder.mutex);queued=decoder.packets.size();}
  int64_t numbers[6]{decoder.submitted.load(),decoder.rendered.load(),decoder.error.load(),queued,decoder.actualWidth.load(),decoder.actualHeight.load()};napi_value result;napi_create_array_with_length(env,6,&result);
  for(uint32_t i=0;i<6;i++){napi_value value;napi_create_int64(env,numbers[i],&value);napi_set_element(env,result,i,value);}return result;
}
napi_value Init(napi_env env,napi_value exports){
  napi_property_descriptor props[]={{"start",nullptr,Start,nullptr,nullptr,nullptr,napi_default,nullptr},{"feed",nullptr,Feed,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stop",nullptr,Stop,nullptr,nullptr,nullptr,napi_default,nullptr},{"stats",nullptr,Stats,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props);RegisterDiPlayAudio(env,exports);RegisterDiPlayMdns(env,exports);return exports;
}
napi_module module={1,0,nullptr,Init,"diplayvideo",nullptr,{0}};
}
extern "C" __attribute__((constructor)) void RegisterDiPlayVideo(){napi_module_register(&module);}
