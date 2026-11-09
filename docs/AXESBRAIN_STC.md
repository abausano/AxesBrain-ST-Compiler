# Formato `.stc` e macchina virtuale AxesBrain (bozza 0.1)

Stato: **bozza da rivedere** con Andrea, 09/11/2026. Scritta da Claude.
Questo documento fa parte del fork GPL `AxesBrain-ST-Compiler` ed è pubblico apposta: il formato `.stc` è una
specifica indipendente che qualunque compilatore può generare e qualunque VM può eseguire (vedi l'analisi di
fattibilità in AxesBrainSRV, §11, regola 3). La VM di AxesBrainSRV è un'implementazione separata e non contiene codice
di questo repository.

## 1. Obiettivi e vincoli

- Eseguire programmi IEC 61131-3 (ST, e IL tramite la traduzione IL → ST già presente) dentro AxesBrainSRV, a
  scansione ciclica sul segnale del driver (`AbtDrvPlcSignalEvt`, 1 ms o 250 µs), nel thread `ThreadTaskST` a
  priorità `HIGHEST`.
- Nessuna allocazione di memoria durante la scansione: tutta la memoria è decisa dal compilatore e allocata al
  caricamento.
- Nessun parsing a run-time: il `.stc` contiene solo indirizzi, indici e costanti già risolti.
- Errori del programma (indice fuori limite, divisione per zero, ciclo infinito) fermano il task, mai SRV.
- Debug: breakpoint per riga, lettura e forzatura delle variabili per nome, impronta MD5 dei sorgenti.
- Stessa semantica del back-end C++ di STruC++, verificata con prove di confronto ciclo per ciclo (§10).

## 2. Il back-end nel compilatore

- Nuovo back-end in `src/backend-stc/`, file nostri, attivato da un'opzione (`--target stc`). Riceve lo stesso
  `CompilationUnit` già analizzato e le stesse tabelle dei simboli che `compile()` passa a `CodeGenerator`
  (`src/index.ts`, ~riga 754). Il front-end e la semantica non si toccano.
- I file del back-end portano, oltre alla GPL-3.0-only, il permesso aggiuntivo sull'output (§11.3 punto 4
  dell'analisi): i pezzi fissi copiati nel `.stc` non vincolano il programma dell'utente.
- Uscite del compilatore: `programma.stc` e un file di diagnostica JSON (errori con file:riga:colonna, già
  prodotti dal front-end).

## 3. Contenitore del file

Binario, little-endian, allineamento a 8 byte delle sezioni.

**Intestazione** (64 byte):

| Campo | Tipo | Note |
|---|---|---|
| magia | 4 byte | `ABST` |
| versione formato | u16 maggiore, u16 minore | la VM rifiuta un maggiore diverso |
| flag | u32 | bit 0: contiene debug |
| md5 sorgenti | 16 byte | MD5 dei `.st` in ingresso, nell'ordine di compilazione |
| versione compilatore | u32 | |
| numero sezioni | u32 | |
| riservato | resto | a zero |

**Tabella delle sezioni**: per ogni sezione `id` (4 caratteri), offset u32, lunghezza u32.

| Sezione | Contenuto |
|---|---|
| `STRS` | tabella delle stringhe (nomi, letterali), UTF-8, indicizzata |
| `TYPE` | tabella dei tipi (§4) |
| `CONS` | costanti grandi (LREAL, LINT, stringhe letterali, inizializzatori di array/struct) |
| `DATA` | dimensione e immagine iniziale del segmento globale (§5) |
| `POUS` | funzioni, function block, programmi: codice, dimensioni, variabili (§6) |
| `CODE` | bytecode di tutte le POU (§7) |
| `TASK` | task e programmi associati (§8) |
| `IOMP` | variabili con indirizzo `%I/%Q/%M` (§9) |
| `NATV` | funzioni native richieste a SRV, per nome e firma (§7.6) |
| `DBUG` | simboli e mappa codice → riga:colonna (§10), opzionale |
| `RETN` | elenco delle variabili RETAIN, opzionale |

La VM ignora le sezioni che non conosce (compatibilità in avanti).

## 4. Tipi

Ogni tipo ha un indice nella tabella `TYPE`. Rappresentazione in memoria:

| IEC | Memoria |
|---|---|
| BOOL | 1 byte, 0 o 1 |
| SINT, USINT, BYTE, CHAR | 1 byte |
| INT, UINT, WORD, WCHAR | 2 byte |
| DINT, UDINT, DWORD, REAL | 4 byte |
| LINT, ULINT, LWORD, LREAL | 8 byte |
| TIME, LTIME | 8 byte, nanosecondi con segno (come STruC++) |
| DATE, TOD, DT e varianti L | 8 byte, nanosecondi (da allineare a STruC++ con le prove) |
| STRING(n) | u16 lunghezza attuale + n byte + terminatore; n predefinito 254 |
| WSTRING(n) | u16 lunghezza + 2·(n+1) byte (fase successiva) |
| enum | intero della dimensione del tipo base (predefinito INT) |
| ARRAY | elementi contigui; limiti nella tabella dei tipi |
| STRUCT | campi contigui allineati alla loro dimensione |
| FB | struttura dell'istanza: input, output, in_out (come riferimenti), locali |
| REF_TO / POINTER / REFERENCE_TO | 8 byte: indirizzo VM (§5.2) |

Aritmetica intera: **complemento a due con troncamento alla dimensione del tipo** (come il C++ generato su x64).
Da confermare con le prove di confronto.

## 5. Modello di memoria

### 5.1 Segmenti

- **Globale (G)**: un blocco unico allocato al caricamento. Contiene `VAR_GLOBAL`, istanze dei PROGRAM (una per
  istanza dichiarata in CONFIGURATION), variabili con indirizzo, e dentro le istanze tutte le istanze di FB.
  Le istanze di FB non vivono mai sullo stack: sono parte dei dati del proprietario, come in IEC.
- **Stack delle chiamate**: un blocco per task, dimensione calcolata dal compilatore (profondità massima delle
  chiamate; la ricorsione è vietata dalla norma e rifiutata). Contiene i frame delle FUNCTION (parametri, locali,
  `VAR_TEMP`, valore di ritorno) e i `VAR_TEMP` di FB e PROGRAM.
- **Pila degli operandi**: slot da 8 byte, profondità massima calcolata dal compilatore per POU.

### 5.2 Indirizzi

Un indirizzo VM è un intero a 64 bit: segmento (4 bit alti) + offset. I `REF_TO`, i parametri `VAR_IN_OUT` e gli
output di FB passati per riferimento usano questi indirizzi; la VM verifica segmento e limiti a ogni accesso
indiretto.

### 5.3 Basi degli accessi diretti

Le istruzioni di caricamento e scrittura hanno una base e un offset immediato:

| Base | Significato |
|---|---|
| `G` | segmento globale, offset assoluto |
| `F` | frame corrente sullo stack |
| `I` | istanza corrente (il `this` del FB o del PROGRAM in esecuzione) |
| `P` | indirizzo calcolato in cima alla pila (accesso indiretto) |

## 6. Unità di programma (`POUS`)

Per ogni POU: tipo (FUNCTION, FUNCTION_BLOCK, PROGRAM, METHOD), nome, offset e lunghezza del codice, dimensione
del frame, dimensione dell'istanza (FB/PROGRAM), profondità massima della pila degli operandi, elenco delle
variabili (nome, sezione VAR_*, tipo, offset) per debug e per le chiamate con parametri per nome.

Inizializzazione: l'immagine iniziale del segmento globale (`DATA`) contiene già tutti i valori iniziali, comprese
le istanze di FB. I frame delle FUNCTION sono inizializzati dal codice della POU stessa (prologo generato).

## 7. Bytecode

Macchina a pila. Codice operativo da 1 byte, operandi immediati di lunghezza fissa per ogni codice (u8, u16, u32,
i32). Il tipo è parte del codice operativo (niente controllo dei tipi a run-time).

### 7.1 Famiglie di istruzioni

| Famiglia | Esempi | Note |
|---|---|---|
| Costanti | `PUSH_I32 imm`, `PUSH_I64 idx`, `PUSH_F64 idx`, `PUSH_ZERO` | costanti grandi da `CONS` |
| Caricamento | `LD_<t> base off` con `<t>` = `U8 I8 U16 I16 U32 I32 I64 F32 F64` | estende a 64 bit nello slot |
| Scrittura | `ST_<t> base off` | tronca alla dimensione |
| Indirizzi | `ADDR base off`, `INDEX elem_size type_idx` | `INDEX` controlla i limiti dell'array |
| Copia | `COPY size`, `STRCPY maxlen` | assegnamento di struct, array, stringhe |
| Aritmetica | `ADD_I32 ADD_I64 ADD_F32 ADD_F64`, `SUB`, `MUL`, `DIV`, `MOD`, `NEG`, `EXPT` | `DIV`/`MOD` intere: trappola su divisore 0 |
| Troncamento | `TRUNC_I8 TRUNC_U8 … TRUNC_U32` | riporta il risultato alla dimensione del tipo |
| Confronto | `EQ NE LT LE GT GE` per `I64 U64 F64` | risultato BOOL |
| Bit e logica | `AND OR XOR NOT`, `SHL SHR ROL ROR` per dimensione | |
| Conversioni | `I2F F2I_TRUNC F2I_ROUND F32_F64 F64_F32 …` | `REAL_TO_INT` arrotonda come la norma |
| Salti | `JMP rel32`, `JZ rel32`, `JNZ rel32` | |
| Chiamate | `CALL pou`, `CALLFB pou` (istanza in pila), `CALLM` (metodo), `RET` | |
| Native | `NATIVE idx` | §7.6 |
| Sistema | `NOP`, `BRK` (breakpoint, §10), `TRAP code` | |

Le espressioni di tipo più piccolo di 32 bit si calcolano a 32 o 64 bit e si troncano alla scrittura, come
prevede la promozione degli interi.

### 7.2 Chiamata di FUNCTION

Il chiamante riserva il frame, scrive i parametri nel frame del chiamato (per posizione o per nome: il compilatore
risolve gli offset), esegue `CALL`. Il valore di ritorno è nello slot 0 del frame e viene messo in pila al `RET`.

### 7.3 Chiamata di FUNCTION_BLOCK

Il compilatore scrive gli input direttamente nell'istanza (sono campi del segmento globale), poi `ADDR` istanza e
`CALLFB`; dopo la chiamata legge gli output dall'istanza. `VAR_IN_OUT`: si scrive l'indirizzo nell'istanza.

### 7.4 Controlli a run-time

- `INDEX`: indice fuori dai limiti dell'array → trappola.
- Accessi indiretti: segmento non valido o fuori limite → trappola.
- Divisione intera per zero → trappola. Divisione reale per zero → ±INF/NaN come IEEE (da allineare al C++).
- **Budget di istruzioni** per scansione (watchdog): superato il budget, il task si ferma con un errore. Il budget
  si ricava dal periodo del task.

### 7.5 Trappole

Una trappola ferma **solo quel task**, registra codice, POU, posizione nel codice e riga del sorgente, e SRV la
segnala (evento di errore verso l'HMI). Cosa fare delle uscite del task fermo è una decisione aperta (§12).

### 7.6 Funzioni native (chiamate verso SRV)

- Si dichiarano in ST come FUNCTION senza corpo ST, con il pragma esistente di STruC++:

  ```iecst
  FUNCTION AB_LanciaPP : DINT
    VAR_INPUT NomePP : STRING; END_VAR
    VAR_IN_OUT L : ARRAY[1..32] OF LREAL; END_VAR
    {external native AB_LanciaPP}
  END_FUNCTION
  ```

  Il nostro back-end riconosce `{external native <nome>}` e genera `NATIVE idx`; il back-end C++ incolla il
  pragma come testo, quindi per le prove di confronto si forniscono stub C++ con lo stesso nome. Nessuna modifica
  al front-end.
- La sezione `NATV` elenca nome e firma (tipi dei parametri). Al caricamento la VM collega ogni nome alla tabella
  delle funzioni host di SRV; nome mancante o firma diversa → il programma non si carica.
- Le native non possono bloccare la scansione: le operazioni lunghe (lancio di un `.pp`, movimenti) restituiscono
  un handle e lo stato si legge nelle scansioni successive (FB `MC_*` in tre tempi, analisi §8.3).
- Native fornite dalla VM stessa (non da SRV): funzioni standard su stringhe (`LEN`, `LEFT`, `RIGHT`, `MID`,
  `CONCAT`, `INSERT`, `DELETE`, `REPLACE`, `FIND`), matematiche (`SQRT`, `LN`, `LOG`, `EXP`, `SIN`…), e
  `AB_TIME()`, il tempo all'inizio della scansione, uguale per tutta la scansione (usato dai timer).

## 8. Task (`TASK`)

- Da `CONFIGURATION / RESOURCE / TASK`: nome, `INTERVAL` (ns), `PRIORITY` (ordina i task dentro `ThreadTaskST`),
  programmi associati in ordine.
- Il periodo è arrotondato al multiplo del ciclo del driver; la VM lo segnala se l'arrotondamento cambia il valore.
- Senza CONFIGURATION: un task predefinito con tutti i PROGRAM. **Periodo predefinito da decidere** (§12).
- Task a evento (`SINGLE`): fase successiva.

## 9. Variabili con indirizzo (`IOMP`)

Per ogni variabile `AT %…`: area (I, Q, M), dimensione (X, B, W, D, L), indirizzo (byte, bit), offset nel segmento
globale, tipo.

- La VM, non il codice, copia le aree: a inizio scansione ingressi `%I` e merker `%M` letti; a fine scansione
  uscite `%Q` e merker `%M` scritti **solo se cambiati** (analisi §12.2).
- Corrispondenza con AxesBrain: ingresso/uscita digitale n ↔ `%IX/%QX((n-1)/8).((n-1)%8)`; analogici
  `%IW/%QW n`; merker = I/O virtuali del driver, regola di numerazione da definire.
- I nomi simbolici (`OUT42`, `M1.10`) non sono nel `.stc`: li porta il file di variabili globali generato dall'HMI
  dalla configurazione degli I/O.

## 10. Debug (`DBUG`)

- **Simboli**: nome gerarchico (`Main.Ciclo.Pezzi`, `Main.T1.Q`), tipo, segmento, offset. Bastano per lettura e
  forzatura per nome.
- **Mappa righe**: per ogni POU, coppie (offset nel codice → file, riga, colonna) all'inizio di ogni istruzione ST.
- **Breakpoint**: la VM sostituisce il primo codice operativo della riga con `BRK` e conserva l'originale. Al
  `BRK` il task si sospende a fine istruzione corrente; con un PLC a scansione le uscite restano congelate (decisione
  aperta, analisi §4 punto 7).
- **Forzature**: tabella (indirizzo, valore) applicata dopo la lettura degli ingressi e prima della scrittura delle
  uscite. Le scritture da HMI o COM vanno in coda e si applicano a inizio scansione.
- **Prove di confronto**: lo stesso programma compilato in C++ (back-end originale) e in `.stc`, eseguito N cicli
  con gli stessi ingressi; si confrontano tutte le variabili a ogni ciclo. Corpus: test ed esempi di STruC++,
  OSCAT BASIC, programmi nostri.

## 11. Libreria standard AxesBrain

Scritta da noi in ST, compilata come FB normali (analisi §11.3 punto 4): `TON`, `TOF`, `TP`, `CTU`, `CTD`, `CTUD`,
`R_TRIG`, `F_TRIG`, `SR`, `RS`. I timer usano `AB_TIME()`. Poi i FB `MC_*` che lanciano i `.pp`, e i servizi
(`AB_Display`, `AB_SetEvento`, `AB_GetG`/`AB_SetG`).

## 12. Decisioni aperte

1. Periodo del task predefinito quando manca la CONFIGURATION (proposta: ogni 10 ms).
2. Uscite di un task fermato da una trappola, da un arresto o da un reset: proposta "a 0" (come OpenPLC e
   l'opzione "valori di default" di CODESYS). Con un breakpoint: congelate. Da confermare.
3. Semantica dell'overflow intero e della divisione reale per zero: si fissa con le prove di confronto.
4. **Lancio del PLC ST** (deciso il 09/11/2026, dettagli nell'analisi di AxesBrainSRV §13): sotto-sistema COM
   numero 6 in `ExecSubSystemProcess` / `KillSubSystemProcess` e negli altri metodi che usano il numero; avvio
   automatico con `NomePartProgramLancioST` sotto `[ParametriAUTOMAZIONE]`, dopo `Main.pp`. Si lanciano sia `.st`
   sia `.stc` dalla cartella `partprogST` (valore di registro `PathPartProgramST`): con `.st` la VM confronta l'MD5
   del sorgente con quello nell'intestazione del `.stc` (§3) e segnala se va ricompilato. Il PLC lanciato da
   `sistema.txt` non è resettabile; quello lanciato da COM sì, salvo un bit di `iMaskMode`. Lancio da un `.pp`: si
   decide più avanti.
5. Regola di numerazione dei merker (`M1.10` → `%MX`).
6. Ricarica del programma a macchina accesa: fase successiva (seconda istanza della VM, scambio a fine scansione,
   trasferimento dei valori per nome e tipo).

## 13. Stato del prototipo (09/11/2026)

Prototipo 0.1, fuori da AxesBrainSRV.

- **Back-end** in questo repository: `src/backend-stc/` (`stc-format.ts` codici e costanti, `stc-codegen.ts`
  generatore, `stc-writer.ts` contenitore binario, `cli-stc.ts` riga di comando):

  ```
  node dist/backend-stc/cli-stc.js programma.st libs/axesbrain/ablib.st -o programma.stc [--json diagnostica.json]
  ```

- **Libreria standard** `libs/axesbrain/ablib.st`, scritta da zero, licenza MIT: `R_TRIG`, `F_TRIG`, `SR`, `RS`,
  `CTU`, `CTD`, `CTUD`, `TON`, `TOF`, `TP`, con `AB_TIME()` nativa.
- **Supportato**: tipi elementari interi, BOOL, REAL, LREAL, TIME; array a una dimensione di elementari; FUNCTION
  con parametri per posizione e per nome e valori predefiniti; FUNCTION_BLOCK annidati con `=>` per le uscite;
  PROGRAM; VAR_GLOBAL e VAR_EXTERNAL; CONFIGURATION/RESOURCE/TASK (task predefinito di 10 ms se manca);
  variabili `AT %I/%Q/%M` (X, B, W, D, L); IF/ELSIF/ELSE, CASE con liste e intervalli, FOR con BY, WHILE, REPEAT,
  EXIT, RETURN; conversioni `*_TO_*`, `TRUNC`, `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`, `MOVE`, `SHL`, `SHR`, funzioni
  matematiche, `**`/`EXPT`; funzioni native con `{external native NOME}`; trappole per indice fuori limite,
  divisione per zero e budget di istruzioni, con la riga del sorgente; simboli e mappa delle righe per il debug.
- **Non ancora**: STRING/WSTRING, STRUCT, enum, array multidimensionali o di FB, VAR_IN_OUT, REF_TO/POINTER,
  metodi e interfacce, uscite delle FUNCTION, inizializzatori non costanti, VAR_TEMP reinizializzate a ogni
  chiamata (ora persistono nell'istanza), RETAIN, breakpoint e forzature (i dati per farli ci sono già).
- **Semantica allineata al back-end C++**: aritmetica intera troncata a 32 bit per i tipi fino a 32 bit e a 64 per
  LINT/ULINT, REAL arrotondato a precisione singola dopo ogni operazione, `REAL_TO_INT` con arrotondamento lontano
  da zero (`std::round`), FOR con limite rivalutato a ogni giro e direzione data dal segno di un passo letterale.
  Da verificare con le prove di confronto quando ci sarà g++ (WSL).
- **Prove di regressione** in `tests-stc/`: `STVM=...\stvm-test.exe node tests-stc/esegui.mjs`. Gli output attesi
  sono stati controllati a mano.
- **Prestazioni** misurate con la VM di prova (MSVC x64, `/O2`): circa 5–6 ns per istruzione; una scansione con un
  ciclo di 100 giri su array (~3.700 istruzioni) dura circa 21 µs, il programma `prove1` (~500 istruzioni) circa
  3 µs, i timer di `lib1` circa 0,6 µs.
