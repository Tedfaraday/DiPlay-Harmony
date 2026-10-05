#include <napi/native_api.h>
#include <hilog/log.h>
#include <multimedia/player_framework/native_avcodec_audiocodec.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avformat.h>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {
struct AudioInput {uint32_t index;OH_AVBuffer *buffer;};
struct AudioBytes {std::vector<uint8_t> bytes;int64_t pts;};
class AudioDecoder {
public:
  OH_AVCodec *codec=nullptr;std::atomic<bool> running{false};std::atomic<int32_t> error{0};
  std::mutex mutex;std::condition_variable ready;std::thread worker;
  std::deque<AudioInput> inputs;std::deque<AudioBytes> packets,outputs;size_t outputBytes=0;
  int32_t rate=0,channels=0;bool firstOutput=false,isOpus=false;
  static void Error(OH_AVCodec *,int32_t code,void *ctx){auto *d=static_cast<AudioDecoder *>(ctx);d->error=code;}
  static void Format(OH_AVCodec *,OH_AVFormat *format,void *ctx){
    auto *d=static_cast<AudioDecoder *>(ctx);int32_t rate=0,channels=0,sample=SAMPLE_S16LE;
    const bool hasRate=OH_AVFormat_GetIntValue(format,OH_MD_KEY_AUD_SAMPLE_RATE,&rate);
    const bool hasChannels=OH_AVFormat_GetIntValue(format,OH_MD_KEY_AUD_CHANNEL_COUNT,&channels);
    const bool hasSample=OH_AVFormat_GetIntValue(format,OH_MD_KEY_AUDIO_SAMPLE_FORMAT,&sample);
    if((hasRate&&rate!=d->rate)||(hasChannels&&channels!=d->channels)||(hasSample&&sample!=SAMPLE_S16LE)){d->error=-20;}
  }
  static void Input(OH_AVCodec *,uint32_t index,OH_AVBuffer *buffer,void *ctx){
    auto *d=static_cast<AudioDecoder *>(ctx);std::lock_guard<std::mutex> lock(d->mutex);
    if(d->running){d->inputs.push_back({index,buffer});d->ready.notify_one();}
  }
  static void Output(OH_AVCodec *codec,uint32_t index,OH_AVBuffer *buffer,void *ctx){
    auto *d=static_cast<AudioDecoder *>(ctx);OH_AVCodecBufferAttr attr{};auto err=OH_AVBuffer_GetBufferAttr(buffer,&attr);
    auto *data=OH_AVBuffer_GetAddr(buffer);auto capacity=OH_AVBuffer_GetCapacity(buffer);
    if(err==AV_ERR_OK&&attr.size>0){
      if(!data||attr.offset<0||capacity<0||attr.size>capacity||attr.offset>capacity-attr.size){d->error=-21;}
      else{
        std::lock_guard<std::mutex> lock(d->mutex);
        if(d->running&&d->error==0){
          // Keep decoded data below roughly half a second; stale PCM is dropped at the front.
          while(!d->outputs.empty()&&(d->outputs.size()>=32||d->outputBytes+attr.size>96000)){
            d->outputBytes-=d->outputs.front().bytes.size();d->outputs.pop_front();
          }
          if(attr.size<=96000){d->outputs.push_back({std::vector<uint8_t>(data+attr.offset,data+attr.offset+attr.size),attr.pts});d->outputBytes+=attr.size;
            if(!d->firstOutput){d->firstOutput=true;OH_LOG_Print(LOG_APP,LOG_INFO,0,"DiPlayAudio","Native %{public}s decoder produced first PCM buffer",d->isOpus?"Opus":"AAC");}}
        }
      }
    }else if(err!=AV_ERR_OK){d->error=err;}
    const auto freed=OH_AudioCodec_FreeOutputBuffer(codec,index);if(freed!=AV_ERR_OK&&d->running){d->error=freed;}
  }
  void Stop(){
    {std::lock_guard<std::mutex> lock(mutex);running=false;ready.notify_all();}
    if(worker.joinable()){worker.join();}
    if(codec){OH_AudioCodec_Stop(codec);OH_AudioCodec_Destroy(codec);codec=nullptr;}
    std::lock_guard<std::mutex> lock(mutex);inputs.clear();packets.clear();outputs.clear();outputBytes=0;
  }
  int32_t Start(int32_t sampleRate,int32_t channelCount,bool opus){
    rate=sampleRate;channels=channelCount;isOpus=opus;
    codec=OH_AudioCodec_CreateByMime(opus?OH_AVCODEC_MIMETYPE_AUDIO_OPUS:OH_AVCODEC_MIMETYPE_AUDIO_AAC,false);if(!codec){return -22;}
    OH_AVCodecCallback callback{Error,Format,Input,Output};auto err=OH_AudioCodec_RegisterCallback(codec,callback,this);
    auto *format=OH_AVFormat_Create();if(!format){Stop();return -23;}
    OH_AVFormat_SetIntValue(format,OH_MD_KEY_AUD_SAMPLE_RATE,rate);OH_AVFormat_SetIntValue(format,OH_MD_KEY_AUD_CHANNEL_COUNT,channels);
    OH_AVFormat_SetIntValue(format,OH_MD_KEY_AUDIO_SAMPLE_FORMAT,SAMPLE_S16LE);
    if(opus){
      // OpusHead: version 1, mono, no file pre-skip/gain, 48 kHz, mapping family 0.
      uint8_t header[19]{'O','p','u','s','H','e','a','d',1,1,0,0,0x80,0xbb,0,0,0,0,0};
      OH_AVFormat_SetBuffer(format,OH_MD_KEY_CODEC_CONFIG,header,sizeof(header));
    }else{OH_AVFormat_SetIntValue(format,OH_MD_KEY_AAC_IS_ADTS,1);}
    OH_AVFormat_SetIntValue(format,OH_MD_KEY_MAX_INPUT_SIZE,8192);
    if(err==AV_ERR_OK){err=OH_AudioCodec_Configure(codec,format);}OH_AVFormat_Destroy(format);
    if(err==AV_ERR_OK){err=OH_AudioCodec_Prepare(codec);}if(err!=AV_ERR_OK){Stop();return err;}
    running=true;worker=std::thread([this]{Run();});err=OH_AudioCodec_Start(codec);if(err!=AV_ERR_OK){Stop();return err;}return 0;
  }
  void Run(){while(true){
    AudioInput input{};AudioBytes packet;
    {std::unique_lock<std::mutex> lock(mutex);ready.wait(lock,[this]{return !running||(!inputs.empty()&&!packets.empty());});
      if(!running){return;}input=inputs.front();inputs.pop_front();packet=std::move(packets.front());packets.pop_front();}
    auto *data=OH_AVBuffer_GetAddr(input.buffer);auto capacity=OH_AVBuffer_GetCapacity(input.buffer);
    if(!data||capacity<0||packet.bytes.size()>static_cast<size_t>(capacity)){error=-24;running=false;return;}
    std::memcpy(data,packet.bytes.data(),packet.bytes.size());OH_AVCodecBufferAttr attr{packet.pts,static_cast<int32_t>(packet.bytes.size()),0,AVCODEC_BUFFER_FLAGS_NONE};
    auto err=OH_AVBuffer_SetBufferAttr(input.buffer,&attr);if(err==AV_ERR_OK){err=OH_AudioCodec_PushInputBuffer(codec,input.index);}if(err!=AV_ERR_OK){error=err;running=false;return;}
  }}
  bool Feed(const uint8_t *data,size_t size,int64_t pts){std::lock_guard<std::mutex> lock(mutex);
    if(!running||error!=0||!data||size==0||size>8192||packets.size()>=32){return false;}
    packets.push_back({std::vector<uint8_t>(data,data+size),pts});ready.notify_one();return true;
  }
  ~AudioDecoder(){Stop();}
};
std::unordered_map<int32_t,std::unique_ptr<AudioDecoder>> audioDecoders;int32_t nextAudio=1;
napi_value StartAudio(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);int32_t rate=0,channels=0;char kind[6]="aac";size_t length=0;
  if((argc!=2&&argc!=3)||(argc==3&&(napi_get_value_string_utf8(env,args[2],kind,sizeof(kind),&length)!=napi_ok||length>4))||
    (std::strcmp(kind,"aac")&&std::strcmp(kind,"opus"))||napi_get_value_int32(env,args[0],&rate)!=napi_ok||napi_get_value_int32(env,args[1],&channels)!=napi_ok){
    napi_throw_type_error(env,nullptr,"Invalid audio decoder arguments");return nullptr;
  }
  const bool opus=std::strcmp(kind,"opus")==0;
  if((opus?(rate!=48000||channels!=1):((rate!=44100&&rate!=48000)||channels!=2))||audioDecoders.size()>=4){
    napi_throw_type_error(env,nullptr,"Unsupported audio decoder format or limit");return nullptr;
  }
  auto decoder=std::make_unique<AudioDecoder>();auto err=decoder->Start(rate,channels,opus);napi_value result;
  if(err!=0){OH_LOG_Print(LOG_APP,LOG_WARN,0,"DiPlayAudio","Native %{public}s decoder start failed: %{public}d",opus?"Opus":"AAC",err);napi_create_int32(env,-(err>0?err:-err),&result);return result;}
  const auto id=nextAudio++;audioDecoders.emplace(id,std::move(decoder));napi_create_int32(env,id,&result);return result;
}
AudioDecoder *Get(napi_env env,napi_value id){int32_t number=0;if(napi_get_value_int32(env,id,&number)!=napi_ok){return nullptr;}const auto it=audioDecoders.find(number);return it==audioDecoders.end()?nullptr:it->second.get();}
napi_value FeedAudio(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);void *data=nullptr;size_t size=0;int64_t pts=0;
  auto *decoder=argc==3?Get(env,args[0]):nullptr;
  if(!decoder||napi_get_arraybuffer_info(env,args[1],&data,&size)!=napi_ok||napi_get_value_int64(env,args[2],&pts)!=napi_ok){napi_throw_type_error(env,nullptr,"Invalid audio packet");return nullptr;}
  napi_value result;napi_get_boolean(env,decoder->Feed(static_cast<uint8_t *>(data),size,pts),&result);return result;
}
napi_value ReadAudio(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value id;napi_get_cb_info(env,info,&argc,&id,nullptr,nullptr);auto *decoder=argc==1?Get(env,id):nullptr;napi_value result;
  if(!decoder){napi_get_undefined(env,&result);return result;}if(decoder->error!=0){napi_throw_error(env,nullptr,"Audio decoder failed");return nullptr;}
  AudioBytes output;{std::lock_guard<std::mutex> lock(decoder->mutex);if(decoder->outputs.empty()){napi_get_undefined(env,&result);return result;}
    output=std::move(decoder->outputs.front());decoder->outputs.pop_front();decoder->outputBytes-=output.bytes.size();}
  napi_value buffer,pts;void *data=nullptr;napi_create_arraybuffer(env,output.bytes.size(),&data,&buffer);std::memcpy(data,output.bytes.data(),output.bytes.size());
  napi_create_object(env,&result);napi_create_int64(env,output.pts,&pts);napi_set_named_property(env,result,"data",buffer);napi_set_named_property(env,result,"ptsUs",pts);return result;
}
napi_value StopAudio(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value id;napi_get_cb_info(env,info,&argc,&id,nullptr,nullptr);int32_t number=0;
  if(argc==1&&napi_get_value_int32(env,id,&number)==napi_ok){audioDecoders.erase(number);}napi_value result;napi_get_undefined(env,&result);return result;
}
}
void RegisterDiPlayAudio(napi_env env,napi_value exports){
  napi_property_descriptor props[]={{"startAudio",nullptr,StartAudio,nullptr,nullptr,nullptr,napi_default,nullptr},{"feedAudio",nullptr,FeedAudio,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"readAudio",nullptr,ReadAudio,nullptr,nullptr,nullptr,napi_default,nullptr},{"stopAudio",nullptr,StopAudio,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props);
}
