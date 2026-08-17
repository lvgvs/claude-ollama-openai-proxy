# Claude Code CLI Ollama/OpenAI Proxy

> **Not:** Bu proje ile ilgili hiçbir şey insan kontrolünden geçmedi, tamamen yapay zekâ ile yazılmıştır.

*[English README](README.md)*

[Claude Code CLI](https://code.claude.com/docs) etrafına bir sarmalayıcı koyar; böylece Ollama uyumlu ya da OpenAI uyumlu her istemci Claude ile konuşabilir. Her şey **tek bir `docker-compose.yaml`** dosyasında — Dockerfile yok, imaj derlemesi yok, npm kurulumu yok.

```
istemci ──┬─ :11434  Ollama uyumlu  ──┐
          └─ :3456   OpenAI uyumlu  ──┴──> claude-gateway ──> claude --print ──> Claude
```

---

## Kurmadan önce bunu oku

Bu bir **homelab kolaylık aracı, güvenli bir servis değil.** Neyi çalıştırdığını bilmeni isterim:

- **İki port da varsayılan olarak parolasız.** Makineye `11434` veya `3456` portundan ulaşabilen herkes, hiçbir parola olmadan senin Claude aboneliğini kullanabilir. Normal bir ev ağında bu, misafirler ve IoT cihazları dahil ağdaki her cihaz demektir.
- **Bu portları asla internete açma.** Port yönlendirme yapma, önüne kimlik doğrulaması olmayan bir ters vekil koyma. Riske attığın şey abonelik kotan ve oraya yazılan her şey.
- **Bu projeyi güvenli hale getirip Ollama istemcilerini de çalışır tutmanın bir yolu yok.** [Kimlik doğrulama](#kimlik-doğrulama) bölümüne bak — bu, Ollama protokolünün kendi özelliği, buradaki bir eksiklik değil.
- **Konteyner senin Claude oturum bilgilerini** ana makinedeki bağlı klasörde düz dosya olarak tutar. O klasöre erişebilen herkes oturumunu kopyalayabilir.
- **Konuşmaların diske düz metin olarak yazılıyor.** Aşağıdaki [Verilerin nerede durduğu](#verilerin-nerede-durduğu) bölümüne bak.
- **İstekler birbirinden yalıtılmış değil.** Kullanıcı bazlı sayaç, hız sınırı veya denetim kaydı yok.

Claude Code'un yerleşik araçları (Bash, dosya yazma) **kapalıdır**, dolayısıyla istemciden gelen metin konteyner içinde komut çalıştırmaya dönüşemez. Bu projenin gerçekten uyguladığı tek katı sınır budur. Yukarıdaki diğer her şey senin sorumluluğunda.

Çok kullanıcılı ya da internete açık bir kurulum gerekiyorsa, bu proje doğru başlangıç noktası değil.

## Kimlik doğrulama

**Kısa cevap: Ollama istemcilerinin çalışmasını istiyorsan `API_KEYS` ayarlama.**

Ollama protokolünde kimlik doğrulama başlığı yoktur. Bu protokolün kendisine ait bir özellik, dolayısıyla onu uygulayan hiçbir sunucu — bu proje dahil — hem kimlik bilgisi zorunlu kılıp hem de Ollama istemcileri tarafından kullanılabilir olamaz. Bu ağ geçidini güvenli hale getirmekle Ollama'yı desteklemek birbirini dışlar ve bu, projenin çözebileceği bir şey değil.

Her ayarın gerçekte ne verdiği:

| Ayar | Sonuç |
|---|---|
| `API_KEYS` boş *(varsayılan)* | İki protokol de iki portta çalışır. Hiçbir yerde parola yok. Amaçlanan mod bu. |
| `API_KEYS` ayarlı | İki porttaki her `/v1/...` ve `/api/...` isteği Bearer jetonu ister. OpenAI uyumlu istemciler bunu gönderebilir; **Ollama istemcileri gönderemez, dolayısıyla pratikte yalnızca OpenAI tarafı çalışmaya devam eder.** |
| `API_KEYS` ayarlı, `PROTECT_OLLAMA: "0"` | `/api/...` yeniden açılır, Ollama istemcileri tekrar çalışır — ama aynı modellere iki porttan da `/api/chat` ile jetonsuz erişilebilir hale gelir. Anahtar bir güvenlik sınırı olmaktan çıkıp formaliteye döner. Yalnızca bunu anlayıp kabul ediyorsan kullan. |

İki protokol de iki portta sunulduğu için, birini koruyup diğerini açık bırakmak isteğin yol değiştirerek sızmasına izin verirdi. `API_KEYS`'in yalnızca OpenAI yollarını değil her şeyi kapsamasının sebebi bu.

Canlılık ve keşif uçları (`/`, `/health`) hiçbir zaman kapatılmaz: sunucuyu yoklayamayan bir istemci, anahtarını sunma fırsatı bulamadan vazgeçer.

---

## Verilerin nerede durduğu

Her şey tek bağlı birimin altında kalıcı olur, varsayılanı `/DATA/AppData/claude-code-cli-proxy/home`:

| Yol | İçerik | Okunabilir metin var mı |
|---|---|---|
| `.claude/projects/*/*.jsonl` | Claude Code oturum kayıtları | **Evet — her mesaj, düz metin** |
| `.claude/.credentials.json` | Claude girişin | Jeton |
| `state/sessions.json` | Ağ geçidinin parmak izi tablosu | **Hayır** — yalnızca SHA-256 özetleri, oturum UUID'leri ve zaman damgaları. Konuşma metni buradan geri getirilemez. |
| `.local/`, `work/` | CLI ikilisi ve çalışma dizini | — |

Bu kayıtların var olma sebebi konuşma devamlılığının kendisi: Claude Code'un konuşmayı hatırlaması gerekiyor, hatırlaması da yazması demek. Devamlılığı kapatmak şu an kayıt yazılmasını durdurmuyor — [Bilinen pürüzler](#bilinen-pürüzler) bölümüne bak.

Ağ geçidi, `TRANSCRIPT_RETENTION_HOURS` süresinden (varsayılan 72 saat) eski kayıtları saatte bir ve açılışta bir kez siler. Yalnızca kayıt klasöründeki `.jsonl` dosyalarına dokunulur; oturum bilgisi, ayarlar ve diğer her şey yerinde kalır, yani girişin kalıcıdır. Pencere otomatik olarak en az `SESSION_TTL_HOURS` kadar yükseltilir, böylece hâlâ devam ettirilebilecek bir kayıt asla silinmez. Hiçbir şeyin silinmemesi için değeri `0` yap.

Anthropic dışında hiçbir yere veri gitmiyor, o da CLI'nin kendi bağlantısıyla. Mesaj metni konteyner loglarına düşmez: prompt'lar stdin üzerinden gider ve sistem prompt'u, argümanlar loglanmadan önce uzunluk bilgisiyle değiştirilir.

Kayıtların ne kadar yer kapladığını görmek için:

```bash
du -sh /DATA/AppData/claude-code-cli-proxy/home/.claude/projects/
```

---

## Gereksinimler

- Docker çalıştıran bir makine (ZimaOS, CasaOS, NAS, Linux — fark etmez)
- Claude Code içeren bir Claude aboneliği
- Konteynerden dışarı internet erişimi

---

## Kurulum

### ZimaOS / CasaOS

1. **App Store → Install a Custom App**, [`docker-compose.yaml`](docker-compose.yaml) içeriğini yapıştır, kur.
2. İlk açılışı izle — Claude Code ilk açılışta indiriliyor, bir iki dakika sürer:
   ```bash
   docker logs -f claude-code-cli-ollama-openai-proxy
   ```
3. Bir kereye mahsus giriş yap. **`-u node` kısmını atlama** — root olarak giriş yaparsan oturum dosyası root'a ait olur ve servis okuyamaz:
   ```bash
   docker exec -it -u node claude-code-cli-ollama-openai-proxy claude
   ```
   Ekrandaki bağlantıyı tarayıcıda aç, onayla, kodu terminale yapıştır, sonra `/exit`.
4. Yeniden başlat:
   ```bash
   docker restart claude-code-cli-ollama-openai-proxy
   ```

### Düz Docker

Aynı dosya, aynı adımlar:

```bash
docker compose up -d
```

Önce `docker-compose.yaml` içindeki birim yolunu kendi düzenine göre ayarla — varsayılanı ZimaOS geleneği olan `/DATA/AppData/claude-code-cli-proxy/home`.

---

## Doğrulama

```bash
curl -sS http://MAKINE_IP:11434/api/tags
```

```bash
curl -sS http://MAKINE_IP:11434/api/chat -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Tek cumleyle merhaba de."}],"stream":false}'
```

Canlı sayaçlar — konuşma devamlılığının çalışıp çalışmadığı da burada görünür:

```bash
curl -sS http://MAKINE_IP:3456/v1/usage
```

Buradaki iki sayıyı birlikte okumak gerekir. `session.hitRate`, bir turun tüm geçmişi yeniden oynatmak yerine mevcut konuşmayı ne sıklıkta sürdürdüğünü; `tokens.cacheWrite` ise cache'ten okumak yerine cache'e ne kadar yazıldığını gösterir. Düşük isabet oranının yanındaki büyük bir `cacheWrite`, geçmişin her turda yeniden gönderilip yeniden cache'lendiği anlamına gelir — pahalı olan bozulma biçimi budur ve cache yazımı düz girdiden daha yüksek ücretlendirilir. Ölçek fikri vermesi için: Claude Code 2.1.224'e karşı ölçülen tek satırlık bir istek 2 girdi token'ı ve 3301 cache oluşturma token'ı bildirdi; tamamı CLI'ın kendi sistem prompt'u.

---

## İstemci bağlama

| İstemcideki alan | Değer |
|---|---|
| Ollama taban adresi | `http://MAKINE_IP:11434` |
| OpenAI taban adresi | `http://MAKINE_IP:3456` (çoğu istemci `/v1` kısmını kendi ekler) |
| API anahtarı | `API_KEYS` ayarlamadıysan herhangi bir şey |

**İki port da iki protokolü birden sunar.** Yönlendirme yola göre yapılır — `/v1/...` OpenAI, `/api/...` Ollama — porta göre değil. Dolayısıyla istemciyi "yanlış" porta yönlendirmen sorun çıkarmaz; en sık yapılan kurulum hatası böylece ortadan kalkar: istemci Ollama portuna bağlıyken `/v1/chat/completions` istemeye devam edip yalnızca çıplak bir 404 alması.

İki portun ayrı durmasının sebebi, varsayılan bir port bekleyen istemcilerin aradıklarını bulabilmesi. Hangisi istemcinin işine geliyorsa onu seç.

**Open WebUI kullananlar:** *Settings → Documents → Embedding Engine* ayarını `Default (SentenceTransformers)` olarak bırakın. Bu vekil embedding üretemez; o ayarı buraya yönlendirmek doküman aramasını sessizce bozar.

### Gerçekte ne test edildi

- **[Odysseus](https://github.com/odysseus-dev/odysseus), her iki port üzerinden.** Proje esasen bu istemciye karşı geliştirildi. Akış, görsel girdi, efor seçimi ve çok turlu konuşmaların tamamı onun üzerinden denendi.
- **Resmî Ollama CLI**, `OLLAMA_HOST` ile ağ geçidine yönlendirilerek. Protokolün referans uygulaması olduğu için bağlanıp model listesini alabilmesi anlamlı bir uyumluluk göstergesi — her uç onun üzerinden sürülmemiş olsa da.

Odysseus `11434` portuna yönlendirildiğinde eskiden `404 — Not found: /v1/chat/completions` hatası veriyordu: Ollama portundan bir OpenAI yolu istemeye devam ediyordu. İki protokolün iki portta birden sunulmasının sebebi tam olarak bu uyuşmazlık; aynı yapılandırmanın artık çalıştığı sonradan doğrulandı.

Bu iki protokolden birini konuşan diğer istemcilerin de değişiklik gerektirmeden çalışması beklenir — Open WebUI, LibreChat, Continue ve benzerleri — ancak bunların hiçbiri burada doğrulanmadı, dolayısıyla "çalışması beklenen" olarak görün, "doğrulanmış" değil. Biri sorun çıkarırsa `DEBUG` değerini `1` yap: log tam olarak hangi ucu istediğini gösterir, bu da yukarıdakine benzer bir protokol/adres uyuşmazlığını yakalamaya genelde yeter.

---

## Model ve düşünme eforu seçimi

Model listesi varsayılan olarak `opus`, `sonnet`, `haiku` takma adlarını kullanır. Bunlar her zaman o kademenin güncel modeline gider, dolayısıyla Anthropic yeni bir model çıkardığında ayar değiştirmen gerekmez. Sabit bir sürüm istiyorsan `claude-opus-5` gibi tam adı yazabilirsin.

Efor iki yoldan verilebilir, ikisi de her iki portta çalışır:

**1. Model adına etiket ekle** — hiçbir gelişmiş ayarı olmayan istemcilerde bile çalışır:

```
opus:max      sonnet:high      haiku:low
```

**2. İstek gövdesine alan koy:**

```json
{ "model": "opus", "reasoning_effort": "max" }
```

Ollama istemcileri bunun yerine `"options": { "reasoning_effort": "max" }` kullanır. İkisi birden verilirse gövde kazanır. Geçersiz bir değer reddedilmez, sessizce yok sayılır.

`EFFORT_TAGS` ayarlıyken (varsayılan) her efor varyantı model listesinde de görünür, yani efor bir açılır liste seçeneğine dönüşür: `opus:latest`, `opus:low`, `opus:medium`, `opus:high`, `opus:xhigh`, `opus:max` ve diğer modeller için aynısı.

Her model her seviyeyi desteklemez, ama desteklenmeyen bir seviye **hata vermez** — sessizce kırpılır ya da yok sayılır. Bu yüzden listedeki her kombinasyon güvenle durabilir.

**Efor bir tavandır, tetikleyici değil.** Modelin düşünmesine izin verir, düşünmesini sağlamaz. Düşünüp düşünmeyeceğine model karar verir ve sıradan soruların çoğu hiçbir seviyede düşünme üretmez. Bir kurulumda 213 tur üzerinden ölçüldü: `haiku` turların yaklaşık %90'ında düşündü — üstelik **efor bayrağı hiç yokken**; `opus` `max` ile 15 turda hiç, `sonnet` 162 turda hiç düşünmedi. Kontrollü çiftte sistem prompt'u da soru da birebir aynıydı. Opus doğrudan CLI üzerinden sürüldüğünde düşünme üretiyor, yani bu ağ geçidinin bir hatası değil, modelin ve prompt'un bir özelliği — ama sonuç şu: **daha büyük model ve daha yüksek efor seçmek görünür akıl yürütme elde etmenin yolu değil.** Düşünmeyi görmek istiyorsan güvenilir olan `haiku`.

**Eforun bedeli.** Yüksek seviye daha fazla düşünme satın alır ve düşünme çıktı olarak faturalanır. `opus:max` mevcut en pahalı kombinasyon ve bir açılır listede seçili bırakılıp unutulması çok kolay. Bu senin için önemliyse `/v1/usage`'ı takip et.

---

## Çalışanlar

- **İki protokol de iki portta birden**, akış dahil (OpenAI için SSE, Ollama için NDJSON). Yönlendirme yola göre olduğu için istemciyi hangi porta bağlarsan bağla çalışır.
- **Aboneliğinin eriştiği tüm Claude modelleri**, takma adla ya da tam adla
- **Efor seçimi**, istek bazında ya da model listesinden
- **Function calling**, hem OpenAI hem Ollama biçiminde; araç sonuçları konuşmaya geri besleniyor
- **Düşünme (thinking) ayrı alanda teslim ediliyor.** OpenAI tarafında hem `reasoning_content` hem `reasoning` gönderiliyor — aynı şey için iki isim dolaşımda ve istemciler tanımadıkları alanı sessizce düşürüyor, o yüzden ikisi birden. Ollama tarafında `message.thinking`, `/api/show` içinde `thinking` yeteneği ilan ediliyor ve `think` istek alanı destekleniyor: `false` düşünmeyi tamamen kapatır, seviye (`low`, `medium`, `high`, `max`) eforu belirler. Düşünme cevabın içine asla karışmıyor.
- **Görsel girdi** (png, jpeg, gif, webp), gerçek görsel bloğu olarak iletiliyor
- **Konuşma devamlılığı** — mesaj geçmişinin parmak izi alınıp Claude Code oturumuna eşleniyor, böylece her turda yalnızca yeni mesaj gönderiliyor. Bu, prompt caching'i devreye sokar; uzun sohbetlerde gecikmeyi ve kota tüketimini belirgin şekilde düşürür.
- **Yerleşik araçlar kapalı**, istemci metni konteynerde komut çalıştıramaz

## Çalışmayanlar

- **Embedding.** Claude Code CLI vektör üretemez. `/api/embeddings` ve `/v1/embeddings` sessizce sıfır döndürmek yerine açıklamalı bir `501` döner. İstemcinin kendi embedding motorunu kullan.
- **Uzak görsel adresleri.** Yalnızca base64 ve `data:` adresleri kabul edilir. Konteyner içinden rastgele adres çekmek bir SSRF yüzeyi açacağı için bilerek yapılmıyor; öyle istekler düz metne düşer ve logda uyarı bırakır.
- **`temperature`, `top_p`, `num_predict` ve benzeri örnekleme parametreleri.** CLI bunları kabul etmiyor, dolayısıyla yok sayılıyorlar.
- **Yerleşik function calling.** CLI'da böyle bir arayüz yok; araç şemaları sistem prompt'una katı bir sözleşmeyle enjekte ediliyor ve cevap geri ayrıştırılıyor. Modeller bu sözleşmeyi düzenli olarak çiğniyor — çağrıdan önce anlatım yazıyor, JSON'u kod bloğuna sarıyor, sonrasında yazmaya devam ediyor — bu yüzden ayrıştırıcı hepsini kabul ediyor ve sondaki uydurma kısmı atıyor. Pratikte güvenilir çalışıyor ama garanti değil; yine de ayrıştırılamayan çıktı normal metin sayılıyor.
- **Modeli düzgün biçimde susturmak.** Stop-sequence yok; model araç çağrısını yazdıktan sonra ona "dur" diyen bir şey kalmıyor ve devam edip araç sonuçlarını kendi uyduruyor. Bu metin atılıyor, üstelik varsayılan olarak tam çağrı okunur okunmaz CLI süreci sonlandırıldığı için hiç üretilmiyor — bkz. `TOOL_CALL_EARLY_STOP`.
- **Çok kullanıcı özellikleri.** Sayaç, kota, istemci yalıtımı yok.
- **Yatay ölçekleme.** Tek konteyner, istek başına tek CLI süreci.

## Bilinen pürüzler

- **Uzun bir mesaj modele ortası eksik ulaşabilir.** Ağ geçidi hiçbir yerde kırpma yapmaz — ama modelin context penceresini keşfedemeyen Ollama istemcileri küçük bir varsayılan (çoğunlukla 2048 ya da 4096) kabul edip konuşmayı kendileri kırpar, genelde ortadan atarak. Context uzunluğu artık istemcilerin baktığı bilinen her yerde ilan ediliyor (`/api/show` içinde `parameters` ve `model_info`, `/api/tags` içinde `details`, `/v1/models` içinde `context_window` / `max_model_len`) ve `CONTEXT_LENGTH` bu değeri belirliyor. Ama bir istemcinin bunlardan herhangi birini okuduğunun garantisini bu taraf veremez. Uzun mesajlar hâlâ yarım cevaplanıyorsa `DEBUG` açıp `body: N bytes` satırını gönderdiğin boyutla karşılaştır: istek zaten kısa geldiyse kırpan istemcidir ve çözüm istemcinin ayarlarındadır.
- **Konuşma devamlılığı, istemcinin cevaplarını değiştirmeden geri göndermesine bağlı.** Ağ geçidi oturumu yeniden bulmak için mesaj geçmişinin parmak izini alır; istemci modelin söylediğinin kısaltılmış ya da yeniden yazılmış bir halini geri gönderirse parmak izi tutmaz ve tüm geçmiş yeniden oynatılır. Bu, teşhis logunda görünür: asistan mesajları tam uzunlukta geri gelen turlar `session=hit`, kısaltılmış gelenler her seferinde `session=miss` yazar. Bu taraftan düzeltilemez — çözüm istemcidedir.
- **Kendi araç çağırma yöntemini kullanan bir istemci buradaki tool-call mekanizmasına hiç uğramaz.** Bazı istemciler `tools` alanını hiç kullanmaz; araçlarını kendi sistem prompt'larının içinde tarif edip cevabı kendileri ayrıştırır. Yukarıdaki **Function calling** ile ilgili her şey yalnızca `tools` gönderen istemciler için geçerlidir; diğerleri için ağ geçidi sadece metin taşır ve istemci kaç araç çalıştırırsa çalıştırsın `/v1/usage` içindeki `toolCalls` sıfırda kalır.
- **`TOOL_CALL_EARLY_STOP` yeni ve varsayılanı açık.** Araç çağrısı tamamlanır tamamlanmaz CLI'ı sonlandırmak, modelin araç sonuçlarını uydurmasını engelliyor — boşa giden çıktının büyük kısmı oradan geliyordu. Bu davranışı taklit eden bir stub'a karşı test edildi, uzun süren gerçek bir sohbete karşı değil. Araç kullanan sohbetlerde devamlılık bozulmaya başlarsa `"0"` yap; uydurma metin yine atılır, sadece bedeli ödenir. O turun token'ları nihai sonuç mesajı yerine akış olaylarından okunduğu için sayaçlar her iki durumda da doğru kalır.
- **`ENABLE_SESSIONS: "0"` devamlılığı kapatır ama kayıt yazmayı kapatmaz.** Bu ayar yalnızca ağ geçidinin oturum devam ettirmesini engeller; CLI'ya hâlâ bir oturum kimliği verildiği için konuşma yine diske yazılır. Diskte daha az dosya istiyorsan bunun yerine `TRANSCRIPT_RETENTION_HOURS` değerini düşür.
- Konuşma devamlılığı "elinden geleni yapar" mantığında. Bir mesajı düzenlemek ya da yeniden ürettirmek doğru şekilde yeni oturum açar; bunun bedeli bir kerelik tam geçmiş tekrarıdır.
- `claude --print --resume` bir gün çalışmaz hale gelirse, ağ geçidi sessizce tam geçmişi tekrar oynatmaya döner. Davranış doğru kalır, sadece yavaşlar. Devrede olduğunu doğrulamak için `/v1/usage` içindeki `session.hits` değerine bak.

---

## Ayarlar

Her şey `docker-compose.yaml` içindeki ortam değişkenleriyle yapılır; dosya her birini satır içinde açıklıyor. En çok işine yarayacaklar:

| Değişken | Varsayılan | Ne işe yarar |
|---|---|---|
| `CLAUDE_MODELS` | `opus,sonnet,haiku` | İstemcilere gösterilen modeller |
| `DEFAULT_CLAUDE_MODEL` | `sonnet` | İstemci model belirtmezse ya da tanınmayan bir ad gönderirse |
| `EFFORT_TAGS` | `low,medium,high,xhigh,max` | Model listesinde gösterilen efor varyantları |
| `DEFAULT_EFFORT` | *(boş)* | İstek efor belirtmediğinde kullanılacak seviye |
| `ENABLE_SESSIONS` | `1` | Konuşma devamlılığı |
| `TRANSCRIPT_RETENTION_HOURS` | `72` | Bu süreden eski oturum kayıtlarını sil; `0` hiç silmez |
| `ENABLE_TOOL_CALLS` | `1` | Function calling |
| `ENABLE_THINKING` | `1` | `thinking` yeteneğini ilan et ve düşünmeyi kendi alanında gönder. `0` bunu susturur ve `think` alanını etkisiz kılar; efor seviyesine her iki durumda da dokunmaz |
| `TOOL_CALL_EARLY_STOP` | `1` | Tam araç çağrısı okunur okunmaz CLI'ı sonlandır, model sonuçları uyduramasın. `0` bitmesine izin verir; uydurma metin her hâlükârda atılır |
| `CONTEXT_LENGTH` | `200000` | İstemcilere ilan edilen context penceresi. Yalnızca bir istemci gerçek değerle sorun çıkarırsa düşür |
| `ENABLE_VISION` | `1` | Görsel girdi ve ilan edilen vision yeteneği |
| `API_KEYS` | *(boş)* | Virgülle ayrılmış Bearer jetonları. İki porttaki her yolu korur — [Kimlik doğrulama](#kimlik-doğrulama) |
| `PROTECT_OLLAMA` | `API_KEYS` varsa `1` | `0` yaparsan `/api/...` açık kalır, Ollama istemcileri çalışmaya devam eder |
| `DEBUG` | `1` | Her isteği ve görsel aktarımını logla |

---

## Nasıl çalışıyor

`src/claude-gateway.mjs`, iki HTTP sunucusu çalıştıran ve her istek için `claude --print` süreci açıp protokoller arasında çeviri yapan, bağımlılığı olmayan tek bir Node dosyası.

Bilmeye değer birkaç karar — her biri zor yoldan öğrenildi:

- **Her çağrıda `--tools ""` geçiliyor.** Bu olmadan Claude Code'un yerleşik Bash ve dosya araçları print modunda açık kalıyor; istemcinin yapıştırdığı herhangi bir şey — bir dokümanın içine gizlenmiş metin dahil — konteynerde gerçek komut çalıştırmayı tetikleyebilir.
- **`--bare` bilerek kullanılmıyor.** Yapılandırma taramasını atlayarak açılışı hızlandırıyor ama Claude Code 2.1.223'te oturum bilgisini okumayı da atlıyor; her istek "Not logged in" ile dönüyor.
- **`HEAD /` 200 döner.** Ollama CLI herhangi bir şey yapmadan önce `HEAD` ile yokluyor ve 200 almazsa tamamen vazgeçiyor.
- **`/api/version` istemcinin kendi sürümünü** User-Agent başlığından okuyup geri veriyor, çünkü modern Ollama istemcileri çok eski saydıkları bir sunucuyla konuşmayı reddediyor.
- **Araç çağrısı cevabın tamamında değil, içinde herhangi bir yerde aranır.** Sözleşme çıplak bir JSON nesnesi istiyor; modeller önce anlatım yazıp sonrasında da devam ediyor. Birebir eşleşme aramak, o cevaplarda hiç araç çağrısı bulunamaması demekti — ham JSON ve modelin aracın ne döndüğüne dair hayal ettiği her şey istemciye düz metin olarak gidiyordu. Artık anlatım içerik olarak korunuyor, çağrı ayrıştırılıyor, sonrasındaki her şey atılıyor.
- **Thinking, tahminle değil delta tipiyle ayrıştırılıyor.** Claude Code 2.1.224 yüksek efor seviyesinde `thinking_delta` ve `signature_delta` olaylarıyla ayrı bir içerik bloğu üretiyor. Yalnızca `text_delta` cevaba dönüşüyor; thinking kendi alanına gidiyor, imza atılıyor.
- **Oturum parmak izi, CLI'ın ürettiğinden değil istemcinin geri göndereceğinden kuruluyor.** Araç çağrısı geri `tool_calls` olarak gelir, JSON metni olarak değil; metni parmak izlemek, araç kullanan her turun oturumu ıskalayıp geçmişi yeniden oynatması demekti.
- **Ağ geçidi kaynağında hiç dolar işareti yok**, çünkü kod bir compose dosyasının içine gömülü ve Docker Compose dolarlı süslü parantez ifadelerini kendi değişkeni sanıp değiştirir.
- **Prompt'taki XML etiketleri karakter kodundan üretiliyor**, çünkü ZimaOS özel uygulama içe aktarıcısı YAML'daki köşeli parantezli ifadeleri yer tutucu sanıp kurulumu reddediyor.

---

## Geliştirme

Compose dosyası üretiliyor; YAML'ı değil kaynağı düzenle.

```bash
node scripts/build-compose.mjs
```

Üretici, içinde dolar işareti ya da yer tutucuya benzeyen ifade bulunan bir dosyayı yazmayı reddeder; böylece bu iki tuzak bir daha yaşanmaz.

```bash
npm test
```

Test paketi, ağ geçidini aynı stream-json protokolünü konuşan sahte bir CLI'ya karşı çalıştırır, dolayısıyla hiç API kotası harcanmaz. Protokol çevirisini, akışı, function calling'i, görsel girdiyi, efor seçimini, oturum devamlılığını, resume başarısızlığındaki yedek yolu, kayıt temizliğini ve compose dosyasına gömülen kaynağın birebirliğini kapsar.

İki paket ayrı duruyor, çünkü bu iş asıl zor durumlarda bozuluyor. `test/tools.test.mjs`, araç çağrısı sözleşmesini gerçek bir modelin bozduğu her biçimde bozan cevapları sürer — önce anlatım, kod bloğu, sonrasında uydurma sonuçlar, ve sadece süslü parantez içeren düz metin — ve her birinde istemcinin aynı temiz sonucu gördüğünü, hem akışlı hem akışsız, `TOOL_CALL_EARLY_STOP` hem açık hem kapalıyken doğrular. `test/thinking.test.mjs`, gerçek CLI'dan gözlenen thinking olay şeklini yeniden üretir ve thinking'in istemciye kendi alanında ulaştığını, cevaptan ve parmak izinden uzak durduğunu sabitler.

Paketin büyük kısmı düz Node ve her yerde çalışır. Compose paketi ayrıca YAML'a gömülü açılış scriptini de çalıştırır; bunun için gerçek bir kabuk gerekir — Windows'ta testleri Git Bash içinden çalıştırın ya da `TEST_BASH` değişkenini bir bash'e yönlendirin. Windows'ta `PATH` üzerindeki `bash` çoğu zaman WSL başlatıcısı olan `C:\Windows\System32\bash.exe`'dir ve kurulu dağıtım yoksa hata verir; paket bunu algılayıp o üç kontrolü başarısız değil, atlandı olarak raporlar. En kritik kontrol — kaynağın YAML blok değeri içinden bayt bayt aynı çıkması — saf JavaScript'tir ve her zaman çalışır.

Kayıt temizliği dosya sildiği için kendi test paketine sahip. En önemli kontroller olumsuz olanlar: oturum bilgisi, ayarlar, yeni kayıtlar ve kayıt olmayan dosyaların hepsi hayatta kalmalı.

---

## Teşekkür

Fikir ve genel yaklaşım — Claude Code CLI'yi OpenAI uyumlu bir sunucu olarak sarmalamak ve sohbet geçmişini tek bir prompt'a düzleştirmek — Atal Ashutosh'un **[claude-max-api-proxy](https://github.com/sethschnrt/claude-max-api-proxy)** projesinden (MIT lisanslı) geliyor. O proje hem başlangıç noktası hem de CLI'nin akış protokolünün nasıl davrandığını çözerken başvurduğumuz kaynak oldu.

Buradaki koda o projeden hiçbir şey alınmadı ve o proje burada yeniden dağıtılmıyor; bu ağ geçidi bağımlılığı olmayan bir yeniden yazım olarak sıfırdan yazıldı. Atıf, yolu ilk kez başkası çizdiği için veriliyor.

## Sorumluluk reddi

Bu proje resmî `claude` CLI'sını alt süreç olarak çalıştırır. Jeton çıkarmaz, özel API'leri tersine mühendislikle çözmez, kimlik doğrulamayı atlatmaz — halihazırda kurulu ve giriş yapılmış aracı sarmalar.

Yine de kullanmadan önce [Anthropic'in kullanım şartlarını](https://www.anthropic.com/terms) gözden geçir. Üçüncü taraf araçlara dair politikalar değişebilir ve bir aboneliği API katmanı üzerinden kullanmak planının öngördüğü şey olmayabilir. Kullanım tamamen kendi takdirin ve riskindedir. Bu proje Anthropic ile bağlantılı değildir ve Anthropic tarafından onaylanmamıştır.

## Lisans

[MIT](LICENSE)
