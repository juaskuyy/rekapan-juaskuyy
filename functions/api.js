const COOKIE="juaskuyy_sid";
async function sha256(text){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function json(x,s=200,extra={}){return new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json; charset=utf-8",...extra}})}
function cookieSid(request){const c=request.headers.get("Cookie")||"";const m=c.match(new RegExp(COOKIE+"=([^;]+)"));return m?.[1]||null}
async function auth(request,env){const sid=cookieSid(request);if(!sid)return null;const s=await env.DB.prepare("SELECT s.*,p.name FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?").bind(sid).first();return s||null}
function setCookie(sid,maxAge=315360000){return `${COOKIE}=${sid}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`}
export async function onRequest({request,env}){
 const u=new URL(request.url);
 if(u.pathname!=="/api")return new Response("Not found",{status:404});
 try{
  if(request.method==="GET"){
   const a=u.searchParams.get("action");
   if(a==="profiles"){
    const rows=(await env.DB.prepare("SELECT id,name,CASE WHEN pin_hash IS NULL OR pin_hash='' THEN 0 ELSE 1 END has_pin FROM profiles ORDER BY name").all()).results;
    return json({profiles:rows});
   }
   if(a==="session"){const s=await auth(request,env);return json({logged_in:!!s,profile:s?{id:s.profile_id,name:s.name}:null})}
   const s=await auth(request,env);if(!s)return json({error:"Sesi login berakhir"},401);
   const profile=s.profile_id;
   if(a==="dashboard"){
    const period=await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(profile).first();
    const rooms=(await env.DB.prepare("SELECT id,name,status FROM rooms WHERE profile_id=? ORDER BY id").bind(profile).all()).results;
    const tx=(await env.DB.prepare("SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.profile_id=? AND t.period_id=? ORDER BY t.transaction_date DESC,t.id DESC").bind(profile,period.id).all()).results;
    const income=tx.filter(x=>x.type==="income").reduce((z,x)=>z+x.amount,0),expense=tx.filter(x=>x.type==="expense").reduce((z,x)=>z+x.amount,0);
    const cash=rooms.map(r=>{const ri=tx.filter(x=>Number(x.room_id)===Number(r.id)&&x.type==="income").reduce((z,x)=>z+x.amount,0),re=tx.filter(x=>Number(x.room_id)===Number(r.id)&&x.type==="expense").reduce((z,x)=>z+x.amount,0);return {...r,income:ri,expense:re,cash:ri-re}});
    return json({profile:{id:s.profile_id,name:s.name},period,rooms:cash,transactions:tx,income,expense,final:income-expense});
   }
   if(a==="history"){
    const hs=(await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='closed' ORDER BY id DESC").bind(profile).all()).results;
    return json({history:hs});
   }
   if(a==="shift"){
    const id=Number(u.searchParams.get("id"));const p=await env.DB.prepare("SELECT * FROM periods WHERE id=? AND profile_id=? AND status='closed'").bind(id,profile).first();if(!p)throw Error("Shift tidak ditemukan");
    const tx=(await env.DB.prepare("SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.period_id=? ORDER BY t.transaction_date,t.id").bind(id).all()).results;
    const rooms=(await env.DB.prepare(`
      SELECT cr.id,cr.period_id,cr.room_id,cr.room_name,cr.room_status,
      COALESCE((
        SELECT SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END)
        FROM transactions t WHERE t.period_id=cr.period_id AND t.room_id=cr.room_id
      ),0) AS cash_amount
      FROM closing_rooms cr WHERE cr.period_id=? ORDER BY cr.id
    `).bind(id).all()).results;
    return json({period:p,transactions:tx,rooms});
   }
   if(a==="monthly"){
    const month=u.searchParams.get("month")||new Date().toISOString().slice(0,7);
    const tx=(await env.DB.prepare("SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.profile_id=? AND substr(t.transaction_date,1,7)=? ORDER BY t.transaction_date,t.id").bind(profile,month).all()).results;
    const income=tx.filter(x=>x.type==="income").reduce((z,x)=>z+x.amount,0),expense=tx.filter(x=>x.type==="expense").reduce((z,x)=>z+x.amount,0);
    return json({month,transactions:tx,income,expense,final:income-expense});
   }
   if(a==="backup"){
    const tables=["profiles","periods","rooms","transactions","closing_rooms"];let out={exported_at:new Date().toISOString(),profile};for(const t of tables){const r=(await env.DB.prepare(`SELECT * FROM ${t} WHERE profile_id=?`).bind(profile).all()).results;out[t]=r}
    return json(out);
   }
   throw Error("Action tidak dikenal");
  }
  if(request.method==="POST"){
   const b=await request.json(),a=b.action;
   if(a==="login"){
    const p=await env.DB.prepare("SELECT id,name,pin_hash FROM profiles WHERE id=?").bind(b.profile).first();if(!p)throw Error("Profil tidak ditemukan");
    const hash=await sha256(String(b.pin||""));if(p.pin_hash&&hash!==p.pin_hash)throw Error("PIN salah");
    if(!p.pin_hash && (!b.pin||String(b.pin).length<4))throw Error("Buat PIN minimal 4 digit");
    if(!p.pin_hash){await env.DB.prepare("UPDATE profiles SET pin_hash=? WHERE id=?").bind(hash,p.id).run()}
    const sid=crypto.randomUUID();await env.DB.prepare("INSERT INTO sessions(id,profile_id,expires_at) VALUES(?,?,'9999-12-31 23:59:59')").bind(sid,p.id).run();
    return json({ok:true,first_setup:!p.pin_hash},200,{"set-cookie":setCookie(sid)});
   }
   if(a==="logout"){const sid=cookieSid(request);if(sid)await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(sid).run();return json({ok:true},200,{"set-cookie":setCookie("",0)});
   }
   const s=await auth(request,env);if(!s)return json({error:"Sesi login necessária"},401);const profile=s.profile_id;
   if(a==="change_pin"){const old=await env.DB.prepare("SELECT pin_hash FROM profiles WHERE id=?").bind(profile).first();if((await sha256(String(b.old_pin)))!==old.pin_hash)throw Error("PIN lama salah");await env.DB.prepare("UPDATE profiles SET pin_hash=? WHERE id=?").bind(await sha256(String(b.new_pin)),profile).run();return json({ok:true})}
   if(a==="room"){await env.DB.prepare("INSERT INTO rooms(profile_id,name,status) VALUES(?,?,?)").bind(profile,b.name,b.status||"Kosong").run();return json({ok:true})}
   if(a==="delete_room"){await env.DB.prepare("DELETE FROM rooms WHERE id=? AND profile_id=?").bind(b.id,profile).run();return json({ok:true})}
   if(a==="transaction"){
    const p=await env.DB.prepare("SELECT id FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(profile).first();if(!p)throw Error("Periode aktif tidak ditemukan");
    const type=b.type==="expense"?"expense":"income";if(type==="income"&&b.source_type==="room_rental"&&!b.room_id)throw Error("Sewa Room wajib memilih room");
    await env.DB.prepare("INSERT INTO transactions(profile_id,period_id,room_id,type,source_type,description,amount,transaction_date,transaction_time,notes) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(profile,p.id,b.room_id||null,type,b.source_type||"other_income",b.description,Number(b.amount),b.date,b.time||null,b.notes||null).run();return json({ok:true})
   }
   if(a==="edit_transaction"){
    const row=await env.DB.prepare("SELECT id,period_id FROM transactions WHERE id=? AND profile_id=?").bind(b.id,profile).first();if(!row)throw Error("Transaksi tidak ditemukan");
    if(b.type==="income"&&b.source_type==="room_rental"&&!b.room_id)throw Error("Sewa Room wajib memilih room");
    await env.DB.prepare("UPDATE transactions SET room_id=?,type=?,source_type=?,description=?,amount=?,transaction_date=?,transaction_time=?,notes=? WHERE id=? AND profile_id=?").bind(b.room_id||null,b.type,b.source_type,b.description,Number(b.amount),b.date,b.time||null,b.notes||null,b.id,profile).run();return json({ok:true})
   }
   if(a==="delete_transaction"){await env.DB.prepare("DELETE FROM transactions WHERE id=? AND profile_id=? AND period_id IN (SELECT id FROM periods WHERE status='active')").bind(b.id,profile).run();return json({ok:true})}
   if(a==="closing"){
    const p=await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(profile).first();if(!p)throw Error("Periode aktif tidak ditemukan");
    const start=b.start_date,end=b.end_date;if(!start||!end)throw Error("Tanggal shift wajib diisi");
    const t=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expense FROM transactions WHERE period_id=?").bind(p.id).first();
    await env.DB.prepare("UPDATE periods SET status='closed',closed_at=CURRENT_TIMESTAMP,start_date=?,end_date=?,total_income=?,total_expense=?,final_amount=? WHERE id=?").bind(start,end,t.income,t.expense,t.income-t.expense,p.id).run();
    const rooms=(await env.DB.prepare("SELECT r.id,r.name,r.status,COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END),0)-COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) cash FROM rooms r LEFT JOIN transactions t ON t.room_id=r.id AND t.period_id=? WHERE r.profile_id=? GROUP BY r.id,r.name,r.status").bind(p.id,profile).all()).results;
    for(const r of rooms)await env.DB.prepare("INSERT INTO closing_rooms(period_id,room_id,room_name,room_status,cash_amount) VALUES(?,?,?,?,?)").bind(p.id,r.id,r.name,r.status,r.cash).run();
    await env.DB.prepare("INSERT INTO periods(profile_id,period_number,status) VALUES(?,?,'active')").bind(profile,p.period_number+1).run();return json({ok:true})
   }
   if(a==="delete_history"){
    const p=await env.DB.prepare("SELECT id FROM periods WHERE id=? AND profile_id=? AND status='closed'").bind(b.id,profile).first();if(!p)throw Error("Shift tidak ditemukan");
    await env.DB.prepare("DELETE FROM transactions WHERE period_id=?").bind(p.id).run();await env.DB.prepare("DELETE FROM closing_rooms WHERE period_id=?").bind(p.id).run();await env.DB.prepare("DELETE FROM periods WHERE id=?").bind(p.id).run();return json({ok:true})
   }
   throw Error("Action tidak dikenal");
  }
  return new Response("Method not allowed",{status:405})
 }catch(e){return json({error:e.message},400)}
}
