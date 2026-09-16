// Native TCP integration of the complete original/current WebSocket transport.
// No application authentication, HTTP routing or database is simulated here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { makeWebSocketHarness } from './helpers/resource-utilization-harness.mjs';
import { clientFrame } from './helpers/resource-followup-harness.mjs';

async function pair(t){
  let accept;const accepted=new Promise(resolve=>{accept=resolve;});
  const server=createServer(socket=>accept(socket));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=createConnection({host:'127.0.0.1',port:server.address().port});
  const serverSocket=await accepted;
  t.after(()=>{client.destroy();serverSocket.destroy();server.close();});
  await new Promise(resolve=>client.readyState==='open'?resolve():client.once('connect',resolve));
  return {client,serverSocket};
}
function readBytes(socket,size){
  return new Promise((resolve,reject)=>{
    const parts=[];let length=0;
    const cleanup=()=>{socket.off('data',onData);socket.off('error',onError);socket.off('end',onEnd);};
    const onError=error=>{cleanup();reject(error);};
    const onEnd=()=>onError(Error('transport ended before expected bytes'));
    const onData=data=>{parts.push(data);length+=data.length;if(length>=size){cleanup();resolve(Buffer.concat(parts));}};
    socket.on('data',onData);socket.once('error',onError);socket.once('end',onEnd);
  });
}
for(const mode of ['baseline','current']) test(`native TCP: exact masked input, owned binary view and graceful close (${mode})`,{timeout:15000},async t=>{
  const {client,serverSocket}=await pair(t);
  const {WebSocketConnection}=makeWebSocketHarness(mode,{clock:{setTimeout,clearTimeout,Date}});
  const connection=new WebSocketConnection(serverSocket,2*1024*1024);
  t.after(()=>connection.terminate());
  let messageResolve;const message=new Promise(resolve=>{messageResolve=resolve;});connection.onMessage(value=>messageResolve(value));
  let closedResolve,closedCount=0;const closed=new Promise(resolve=>{closedResolve=resolve;});connection.onClose((code,reason)=>{closedCount++;closedResolve({code,reason});});
  connection.start();client.write(clientFrame(1,Buffer.from('한글 input 😀')));
  assert.deepEqual(await message,{type:'text',text:'한글 input 😀'});
  const source=new Uint8Array(131090);source.fill(0xa5);const value=new Uint8Array(source.buffer,7,131072);value.fill(0x71);
  const received=readBytes(client,131082);connection.sendBinary(value);source.fill(0x99);
  const frame=await received;assert.equal(frame.length,131082);assert.equal(frame[0],0x82);assert.equal(frame[1],127);assert.equal(frame.readBigUInt64BE(2),131072n);assert.deepEqual(frame.subarray(10),Buffer.alloc(131072,0x71));
  const closeFrame=readBytes(client,6);connection.close(1000,'ok');assert.deepEqual(await closeFrame,Buffer.from([0x88,4,3,232,111,107]));
  client.write(clientFrame(8,Buffer.from([3,232])));
  await once(client,'end');await closed;assert.equal(closedCount,1);assert.equal(connection.isOpen,false);
});
