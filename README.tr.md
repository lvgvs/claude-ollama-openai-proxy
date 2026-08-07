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

---

## Çalışanlar

- **İki protokol de iki portta birden**, akış dahil (OpenAI için SSE, Ollama için NDJSON). Yönlendirme yola göre olduğu için istemciyi hangi porta bağlarsan bağla çalışır.
- **Aboneliğinin eriştiği tüm Claude modelleri**, takma adla ya da tam adla
- **Efor seçimi**, istek bazında ya da model listesinden
- **Function calling**, hem OpenAI hem Ollama biçiminde; araç sonuçları konuşmaya geri besleniyor
- **Görsel girdi** (png, jpeg, gif, webp), gerçek görsel bloğu olarak iletiliyor
- **Konuşma devamlılığı** — mesaj geçmişinin parmak izi alınıp Claude Code oturumuna eşleniyor, böylece her turda yalnızca yeni mesaj gönderiliyor. Bu, prompt caching'i devreye sokar; uzun sohbetlerde gecikmeyi ve kota tüketimini belirgin şekilde düşürür.
- **Yerleşik araçlar kapalı**, istemci metni konteynerde komut çalıştıramaz

## Çalışmayanlar

- **Embedding.** Claude Code CLI vektör üretemez. `/api/embeddings` ve `/v1/embeddings` sessizce sıfır döndürmek yerine açıklamalı bir `501` döner. İstemcinin kendi embedding motorunu kullan.
- **Uzak görsel adresleri.** Yalnızca base64 ve `data:` adresleri kabul edilir. Konteyner içinden rastgele adres çekmek bir SSRF yüzeyi açacağı için bilerek yapılmıyor; öyle istekler düz metne düşer ve logda uyarı bırakır.
- **`temperature`, `top_p`, `num_predict` ve benzeri örnekleme parametreleri.** CLI bunları kabul etmiyor, dolayısıyla yok sayılıyorlar.
- **Yerleşik function calling.** CLI'da böyle bir arayüz yok; araç şemaları sistem prompt'una katı bir sözleşmeyle enjekte ediliyor ve cevap geri ayrıştırılıyor. Pratikte güvenilir çalışıyor ama garanti değil; ayrıştırılamayan çıktı normal metin sayılıyor.
- **Çok kullanıcı özellikleri.** Sayaç, kota, istemci yalıtımı yok.
- **Yatay ölçekleme.** Tek konteyner, istek başına tek CLI süreci.

## Bilinen pürüzler

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
