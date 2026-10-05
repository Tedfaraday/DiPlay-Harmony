// Hotspot-bound IPv4 mDNS transport. DNS parsing and service policy live in ArkTS.
#include <napi/native_api.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <ifaddrs.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <cerrno>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>

namespace {
struct DiscoverySocket {
  int fd=-1;unsigned index=0;in_addr address{},mask{};
  ~DiscoverySocket(){if(fd>=0){close(fd);}}
};
std::unordered_map<int,std::unique_ptr<DiscoverySocket>> sockets;
int nextHandle=1;
napi_value Fail(napi_env env,const char *stage){
  const std::string message=std::string("Hotspot mDNS ")+stage+" error "+std::to_string(errno);
  napi_throw_error(env,nullptr,message.c_str());return nullptr;
}
bool Text(napi_env env,napi_value value,std::string &result){
  size_t length=0;if(napi_get_value_string_utf8(env,value,nullptr,0,&length)!=napi_ok||length<1||length>15){return false;}
  result.resize(length+1);napi_get_value_string_utf8(env,value,result.data(),result.size(),&length);result.resize(length);
  return result.find('\0')==std::string::npos;
}
bool Interface(DiscoverySocket &s){
  ifaddrs *list=nullptr;if(getifaddrs(&list)!=0){return false;}
  for(auto *item=list;item;item=item->ifa_next){
    if(!item->ifa_addr||!item->ifa_netmask||item->ifa_addr->sa_family!=AF_INET||(item->ifa_flags&IFF_LOOPBACK)){continue;}
    auto *addr=reinterpret_cast<sockaddr_in *>(item->ifa_addr);
    if(addr->sin_addr.s_addr!=s.address.s_addr){continue;}
    s.index=if_nametoindex(item->ifa_name);s.mask=reinterpret_cast<sockaddr_in *>(item->ifa_netmask)->sin_addr;
    break;
  }
  freeifaddrs(list);if(!s.index){errno=EADDRNOTAVAIL;return false;}return true;
}
napi_value Start(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string text;auto s=std::make_unique<DiscoverySocket>();
  if(argc!=1||!Text(env,args[0],text)||inet_pton(AF_INET,text.c_str(),&s->address)!=1||sockets.size()>=2){
    napi_throw_type_error(env,nullptr,"Invalid hotspot mDNS address or socket limit");return nullptr;
  }
  if(!Interface(*s)){return Fail(env,"interface");}
  s->fd=socket(AF_INET,SOCK_DGRAM|SOCK_CLOEXEC,0);if(s->fd<0){return Fail(env,"socket");}
  int one=1,ttl=255,zero=0;
  if(setsockopt(s->fd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one))<0||
     setsockopt(s->fd,IPPROTO_IP,IP_PKTINFO,&one,sizeof(one))<0||
     setsockopt(s->fd,IPPROTO_IP,IP_MULTICAST_IF,&s->address,sizeof(s->address))<0||
     setsockopt(s->fd,IPPROTO_IP,IP_MULTICAST_TTL,&ttl,sizeof(ttl))<0||
     setsockopt(s->fd,IPPROTO_IP,IP_TTL,&ttl,sizeof(ttl))<0||
     setsockopt(s->fd,IPPROTO_IP,IP_MULTICAST_LOOP,&zero,sizeof(zero))<0){return Fail(env,"options");}
  sockaddr_in local{};local.sin_family=AF_INET;local.sin_port=htons(5353);local.sin_addr.s_addr=INADDR_ANY;
  if(bind(s->fd,reinterpret_cast<sockaddr *>(&local),sizeof(local))<0){return Fail(env,"bind");}
  ip_mreq membership{};inet_pton(AF_INET,"224.0.0.251",&membership.imr_multiaddr);membership.imr_interface=s->address;
  if(setsockopt(s->fd,IPPROTO_IP,IP_ADD_MEMBERSHIP,&membership,sizeof(membership))<0||
     fcntl(s->fd,F_SETFL,fcntl(s->fd,F_GETFL,0)|O_NONBLOCK)<0){return Fail(env,"membership");}
  const int handle=nextHandle++;sockets.emplace(handle,std::move(s));napi_value result;napi_create_int32(env,handle,&result);return result;
}
DiscoverySocket *Get(napi_env env,napi_value value){
  int32_t handle=0;if(napi_get_value_int32(env,value,&handle)!=napi_ok){return nullptr;}
  auto found=sockets.find(handle);return found==sockets.end()?nullptr:found->second.get();
}
napi_value Send(napi_env env,napi_callback_info info){
  size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  void *data=nullptr;size_t size=0;auto *s=argc>=2?Get(env,args[0]):nullptr;std::string target="224.0.0.251";
  sockaddr_in destination{};destination.sin_family=AF_INET;destination.sin_port=htons(5353);
  if(!s||napi_get_arraybuffer_info(env,args[1],&data,&size)!=napi_ok||size<12||size>1400||
     (argc==3&&!Text(env,args[2],target))||inet_pton(AF_INET,target.c_str(),&destination.sin_addr)!=1){
    napi_throw_type_error(env,nullptr,"Invalid hotspot mDNS datagram");return nullptr;
  }
  const uint32_t address=ntohl(destination.sin_addr.s_addr);
  if(target!="224.0.0.251"&&((destination.sin_addr.s_addr&s->mask.s_addr)!=(s->address.s_addr&s->mask.s_addr)||
      address==0||address==0xffffffffU||((address&0xf0000000U)==0xe0000000U)||
      (destination.sin_addr.s_addr|s->mask.s_addr)==0xffffffffU)){
    napi_throw_type_error(env,nullptr,"mDNS target outside hotspot subnet");return nullptr;
  }
  // Select the hotspot interface for both multicast and authenticated-phone unicast.
  char ancillary[CMSG_SPACE(sizeof(in_pktinfo))]{};iovec vector{data,size};msghdr message{};
  message.msg_name=&destination;message.msg_namelen=sizeof(destination);message.msg_iov=&vector;message.msg_iovlen=1;
  message.msg_control=ancillary;message.msg_controllen=sizeof(ancillary);auto *control=CMSG_FIRSTHDR(&message);
  control->cmsg_level=IPPROTO_IP;control->cmsg_type=IP_PKTINFO;control->cmsg_len=CMSG_LEN(sizeof(in_pktinfo));
  auto *packet=reinterpret_cast<in_pktinfo *>(CMSG_DATA(control));packet->ipi_ifindex=s->index;packet->ipi_spec_dst=s->address;
  const ssize_t sent=sendmsg(s->fd,&message,0);
  if(sent<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK){return Fail(env,"send");}
  napi_value result;napi_get_boolean(env,sent==static_cast<ssize_t>(size),&result);return result;
}
napi_value Read(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto *s=argc==1?Get(env,args[0]):nullptr;napi_value result;napi_get_undefined(env,&result);if(!s){return result;}
  uint8_t bytes[9001];char ancillary[CMSG_SPACE(sizeof(in_pktinfo))]{};sockaddr_in remote{};
  iovec vector{bytes,sizeof(bytes)};msghdr message{};message.msg_name=&remote;message.msg_namelen=sizeof(remote);
  message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof(ancillary);
  const ssize_t received=recvmsg(s->fd,&message,MSG_DONTWAIT);
  if(received<0){if(errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR){return result;}return Fail(env,"receive");}
  if(received<12||received>9000||(message.msg_flags&(MSG_TRUNC|MSG_CTRUNC))||remote.sin_port!=htons(5353)){return result;}
  bool correctInterface=false,unicast=false;
  for(auto *control=CMSG_FIRSTHDR(&message);control;control=CMSG_NXTHDR(&message,control)){
    if(control->cmsg_level==IPPROTO_IP&&control->cmsg_type==IP_PKTINFO&&control->cmsg_len>=CMSG_LEN(sizeof(in_pktinfo))){
      const auto *packet=reinterpret_cast<const in_pktinfo *>(CMSG_DATA(control));
      correctInterface=packet->ipi_ifindex==static_cast<int>(s->index);
      unicast=packet->ipi_addr.s_addr==s->address.s_addr;
    }
  }
  if(!correctInterface||(remote.sin_addr.s_addr&s->mask.s_addr)!=(s->address.s_addr&s->mask.s_addr)){return result;}
  napi_create_object(env,&result);void *output=nullptr;napi_value value;
  napi_create_arraybuffer(env,received,&output,&value);std::memcpy(output,bytes,received);napi_set_named_property(env,result,"data",value);
  char address[INET_ADDRSTRLEN];inet_ntop(AF_INET,&remote.sin_addr,address,sizeof(address));
  napi_create_string_utf8(env,address,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,result,"address",value);
  napi_get_boolean(env,unicast,&value);napi_set_named_property(env,result,"unicast",value);return result;
}
napi_value Stop(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);int32_t handle=0;
  if(argc==1&&napi_get_value_int32(env,args[0],&handle)==napi_ok){sockets.erase(handle);}
  napi_value result;napi_get_undefined(env,&result);return result;
}
}
void RegisterDiPlayMdns(napi_env env,napi_value exports){
  napi_property_descriptor props[]={{"startDiscovery",nullptr,Start,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"sendDiscovery",nullptr,Send,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"readDiscovery",nullptr,Read,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopDiscovery",nullptr,Stop,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props);
}
