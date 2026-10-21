# Velto Export Studio

Aplicativo estático sem dependências, contas, uploads, APIs ou serviços externos. Abra `index.html` em um servidor estático HTTP para usar os módulos JavaScript. Todos os arquivos ficam na memória do navegador.

## Formato

Aceita dados brutos do projeto, `{Data: ...}`, `{Project: ...}` ou o envelope portátil:

```json
{
  "Format": "Velto Project",
  "Version": 1,
  "Project": {"Name":"My Set","BPM":118,"ArrangementLength":32,"Tracks":[],"Clips":{},"Master":{"Id":"master","Volume":1,"Pan":0,"Muted":false,"Effects":[]}},
  "Samples": [{"Id":"rbxassetid://123456789","Name":"Original kick","Volume":0.5,"Loop":false,"Duration":1}]
}
```

O arranjo usa o esquema do Velto: `Tracks[].Arrangement = [{Id, ClipId, Start, Length, Offset}]`, `Clips` por ID, MIDI com `Notes`, áudio com `SampleId, Start, End, Gain, Transpose`; clips consolidados contêm `Segments = [{At, Length, SampleId, Start, End, Gain, Transpose}]`. Tempos do arranjo são beats; Start/End de áudio são segundos. Cores são índices 1–6. Volume dos samples é necessário para reproduzir os ganhos do projeto; na ausência, assume 0,5.

Associe os arquivos originais com o ID numérico no nome, por exemplo `123456789.wav` ou `kick-123456789.wav`. Nomes exatos e únicos que coincidam com os nomes em Samples também são reconhecidos. O aplicativo não baixa, extrai nem redistribui áudio a partir de IDs Roblox. A disponibilidade de um áudio no jogo não significa que ele pode ser usado externamente.

## Exportações

- **JSON** preserva o envelope carregado.
- **MIDI SMF formato 1** inclui notas de todas as faixas MIDI no arranjo (incluindo mutes/solos, pois é exportação de dados), nomes, andamento e compasso 4/4. Não incorpora timbres, efeitos ou áudio.
- **WAV PCM 16 bits estéreo** usa OfflineAudioContext com 22,05/44,1/48 kHz, cauda configurável e limite de cinco minutos de arranjo. Não normaliza silenciosamente; avisa se houver clipping.

O WAV respeita mute/solo, volume e balanço estéreo, offsets, loops, recortes, regiões consolidadas, velocidade de notas, sample zones e Drum Rack. Todas as faixas passam pela cadeia Master antes da saída. Clips sobrepostos bloqueiam a exportação para evitar um comportamento diferente do seletor de clips do jogo.

## Fidelidade e limites

Este é um **motor alternativo Web Audio**, não uma gravação nem um bounce do motor de áudio do Roblox. Há confirmação explícita na interface; os algoritmos dos filtros, compressores e demais efeitos podem soar diferentes. Não é possível prometer equivalência de áudio com o jogo.

Efeitos funcionais: EQ, Compressor, Multiband, Saturation, Reverb, Amp, Utility, Delay, Chorus, Flanger e Tremolo. São modelos Web Audio próprios com controles correspondentes, sem copiar os algoritmos proprietários de Roblox ou plugins comerciais. **Pitch, Abyss, Chromatic e efeitos desconhecidos ativos bloqueiam a renderização**. Eles nunca são descartados silenciosamente. Desative efeitos incompatíveis no projeto antes de renderizar; efeitos ignorados por estarem desativados ou com Mix zero não alteram áudio.

Analog/Prism/Vector podem usar os arquivos originais dos osciladores sampleados do Velto. A opção **Osciladores do navegador**, desativada por padrão, permite uma interpretação aproximada com OscillatorNode; não reproduz o timbre exato dos samples. A demonstração autoral usa esse modo e carrega o aviso correspondente. Sem originais, samples comuns e instrumentos de piano/bateria continuam bloqueando o WAV; não são substituídos por sons genéricos.

Não há automação de parâmetros, warp/time-stretch, gravação de microfone, MP3, extração de áudio Roblox ou acesso a assets privados. A renderização representa o Arrangement; clips exclusivos da Session não são exportados.

## Hospedagem

Os arquivos desta pasta podem ser servidos por uma hospedagem estática apropriada ao uso comercial do Velto. Não há backend de renderização. Não coloque links, QR codes ou redirecionamentos externos dentro da experiência Roblox como forma de contornar suas regras de links; a integração do jogo fornece apenas os dados portáteis do projeto.

## Verificação

`engine.test.mjs` testa o planejamento de arranjo, loops, offsets, MIDI, cabeçalho/PCM WAV, bloqueio de efeitos incompatíveis e sample faltante usando Node. Não depende de DOM ou rede. A renderização real usa a implementação OfflineAudioContext do navegador.