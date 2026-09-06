// macOS offline render. The installed system sound bank is referenced, never copied.
// Usage: swift -module-cache-path /tmp/sundoll-swift-modules render_score.swift score.json raw.wav
import Foundation
import AVFoundation
import AudioToolbox

struct Instrument: Decodable { let name:String; let program:Int; let gain:Float; let pan:Float; let percussion:Bool }
struct Note: Decodable { let instrument:Int; let beat:Double; let pitch:Int; let duration:Double; let velocity:Int }
struct Score: Decodable { let title:String; let bpm:Double; let lengthBeats:Double; let instruments:[Instrument]; let notes:[Note]; let reverb:Float; let loop:Bool? }
struct Event { let frame:Int64; let instrument:Int; let pitch:Int; let velocity:Int; let on:Bool }

func render(_ input:String,_ output:String) throws {
    let score=try JSONDecoder().decode(Score.self,from:Data(contentsOf:URL(fileURLWithPath:input)))
    let engine=AVAudioEngine()
    let mix=AVAudioMixerNode(), reverb=AVAudioUnitReverb()
    engine.attach(mix); engine.attach(reverb)
    let format=AVAudioFormat(standardFormatWithSampleRate:44100,channels:2)!
    reverb.loadFactoryPreset(.mediumHall); reverb.wetDryMix=score.reverb
    engine.connect(mix,to:reverb,format:format)
    engine.connect(reverb,to:engine.mainMixerNode,format:format)
    mix.outputVolume=0.8
    var samplers:[AVAudioUnitSampler]=[]
    let soundbank=URL(fileURLWithPath:"/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
    for inst in score.instruments {
        let sampler=AVAudioUnitSampler();engine.attach(sampler)
        try sampler.loadSoundBankInstrument(at:soundbank,program:UInt8(inst.program),bankMSB:UInt8(inst.percussion ? kAUSampler_DefaultPercussionBankMSB:kAUSampler_DefaultMelodicBankMSB),bankLSB:0)
        sampler.masterGain=inst.gain;sampler.stereoPan=inst.pan
        engine.connect(sampler,to:mix,format:format);samplers.append(sampler)
    }
    let cycleFrames=Int64((score.lengthBeats*60/score.bpm*44100).rounded())
    var events:[Event]=[]
    let cycles = score.loop == false ? 1 : 2
    let writeFrom = cycles == 1 ? Int64(0) : cycleFrames
    // Warm up one whole musical cycle so reverb and release tails are present at the loop start.
    for cycle in 0..<cycles {
        for note in score.notes {
            let start=Int64((note.beat*60/score.bpm*44100).rounded())+Int64(cycle)*cycleFrames
            let end=Int64(((note.beat+note.duration)*60/score.bpm*44100).rounded())+Int64(cycle)*cycleFrames
            events.append(Event(frame:start,instrument:note.instrument,pitch:note.pitch,velocity:note.velocity,on:true))
            events.append(Event(frame:end,instrument:note.instrument,pitch:note.pitch,velocity:0,on:false))
        }
    }
    events.sort { $0.frame == $1.frame ? (!$0.on && $1.on) : $0.frame < $1.frame }
    try engine.enableManualRenderingMode(.offline,format:format,maximumFrameCount:2048)
    try engine.start()
    var settings=format.settings;settings[AVLinearPCMIsNonInterleaved]=false
    var file:AVAudioFile?=try AVAudioFile(forWriting:URL(fileURLWithPath:output),settings:settings)
    let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:2048)!
    var position:Int64=0, index=0, written:Int64=0, retries=0
    while position<cycleFrames*Int64(cycles) {
        while index<events.count && events[index].frame<=position {
            let e=events[index];let channel:UInt8=score.instruments[e.instrument].percussion ? 9:0
            if e.on {samplers[e.instrument].startNote(UInt8(e.pitch),withVelocity:UInt8(e.velocity),onChannel:channel)}
            else {samplers[e.instrument].stopNote(UInt8(e.pitch),onChannel:channel)}
            index += 1
        }
        let nextEvent=index<events.count ? events[index].frame:cycleFrames*Int64(cycles)
        let boundary=position<cycleFrames ? cycleFrames:cycleFrames*Int64(cycles)
        let count=AVAudioFrameCount(min(2048,nextEvent-position,boundary-position))
        if count==0 {continue}
        let status=try engine.renderOffline(count,to:buffer)
        switch status {
        case .success:
            if position>=writeFrom {try file!.write(from:buffer);written += Int64(buffer.frameLength)}
            position += Int64(buffer.frameLength);retries=0
        case .cannotDoInCurrentContext, .insufficientDataFromInputNode:
            retries += 1
            if retries>100 {throw NSError(domain:"offline-render",code:1,userInfo:[NSLocalizedDescriptionKey:"Manual renderer stalled"])}
        case .error: throw NSError(domain:"offline-render",code:2)
        @unknown default: throw NSError(domain:"offline-render",code:3)
        }
    }
    engine.stop()
    file=nil // Flush the WAV header before returning, including when invoked by the Swift interpreter.
    print("\(score.title): \(written) frames, \(Double(written)/44100) seconds")
}
if CommandLine.arguments.count != 3 {fputs("Usage: render_score.swift score.json raw.wav\n",stderr);exit(2)}
do {try render(CommandLine.arguments[1],CommandLine.arguments[2])}
catch {fputs("Render failed: \(error)\n",stderr);exit(1)}
