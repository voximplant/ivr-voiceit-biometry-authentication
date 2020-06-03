require(Modules.ApplicationStorage)
require(Modules.Recorder)

// apiKey and apiToken can be obtained in Voiceit developer console at https://voiceit.io/settings
const apiKey = 'YOUR_VOICEIT_APIKEY',
    apiToken = 'YOUR_VOICEIT_APITOKEN',
    phrase = 'my face and voice identify me', // you can use other phrases or add new ones at https://voiceit.io/phraseManagement
    contentLanguage = 'en-US',
    voice = VoiceList.Google.en_US_Wavenet_C

let callerid,
    userId = null,
    call,
    recorder,
    enrollCount = 0,
    timerId

// A simple wrapper for http request
async function httpRequest(url, method = 'GET', contentType = 'application/json', postData) {
    return new Promise(async (resolve, reject) => {
        try {
            let options = {
                headers: [
                    'Authorization: Basic ' + base64_encode(apiKey + ':' + apiToken),
                    'Content-Type: ' + contentType
                ],
                method: method
            }
            if (postData !== undefined) options.postData = JSON.stringify(postData)
            let res = await Net.httpRequestAsync(url, options)
            if (res.code == 200 || res.code == 201) {
                res = JSON.parse(res.text)
                resolve(res)
            } else {
                reject('Error code: ' + res.code)
            }
        } catch (err) {
            reject('Error: ' + err)
        }
    })
}

// Handle incoming call
VoxEngine.addEventListener(AppEvents.CallAlerting, async (e) => {
    callerid = e.callerid
    call = e.call
    call.addEventListener(CallEvents.Connected, onCallConnected)
    call.addEventListener(CallEvents.Disconnected, VoxEngine.terminate)
    call.addEventListener(CallEvents.Failed, VoxEngine.terminate)
    call.answer()
})

async function onCallConnected(e) {
    // Check if have Voiceit userId corresponding to the callerid in the app storage
    try {
        userId = await ApplicationStorage.get(callerid)
        if (userId != null) userId = userId.value
    } catch (err) {
        Logger.write(err)
        // Couldn't retrieve the callerid-userId pair from the application storage, can live w/o it for demo purposes
    }
    // No userId exists for the specified callerid, creating it
    if (userId == null) {        
        try {
            // See https://api.voiceit.io/?shell#create-a-user
            let res = await httpRequest('https://api.voiceit.io/users', 'POST', {})
            if (res.responseCode == 'SUCC') {
                userId = res.userId
                // Store the callerid-userId pair for 30 days
                ApplicationStorage.put(callerid, userId, 2592000).then((res) => {
                    call.say(`<speak>Welcome to the Voice Authentication system. You are a new user, you will now be enrolled. You will be asked to say a phrase 3 times, then you will be able to log in with that phrase. Please say the following phrase. <break time="1s"/>${phrase}.</speak>`, voice)
                    call.addEventListener(CallEvents.PlaybackFinished, (event) => {
                        call.removeEventListener(CallEvents.PlaybackFinished)
                        startEnrollment()
                    })
                }).catch((err) => {                    
                    Logger.write(err)
                    // Couldn't save the callerid-userId pair in the application storage, can live w/o it for demo purposes
                })
            }
        } catch (err) {
            Logger.write(err)
            // Couldn't create Voiceit user
            terminateGracefully()
        }
    } else {
        // Enabled DTMF handling
        call.handleTones(true)
        call.say('You have called Voice Authentication. Your phone number has been recognized. You can now log in, or press 1 now to enroll for the first time.', voice)
        call.addEventListener(CallEvents.PlaybackFinished, (event) => {
            timerId = setTimeout(() => {
                call.removeEventListener(CallEvents.PlaybackFinished)
                authenticate()
            }, 3000)
        })
        call.addEventListener(CallEvents.ToneReceived, (event) => {
            // The caller pressed 1 to enroll
            if (event.tone == '1') {
                clearTimeout(timerId)
                call.handleTones(false)
                call.removeEventListener(CallEvents.PlaybackFinished)
                call.stopPlayback()
                call.say(`<speak>Welcome to the Voice Authentication system. You are a new user, you will now be enrolled. You will be asked to say a phrase 3 times, then you will be able to log in with that phrase. Please say the following phrase. <break time="1s"/> ${phrase}.</speak>`, voice)
                call.addEventListener(CallEvents.PlaybackFinished, startEnrollment)
            }
        })
    }
}

function startEnrollment() {
    call.removeEventListener(CallEvents.PlaybackFinished)
    let recordingURL, timer = null
    // Use flac format for the best possible quality
    recorder = VoxEngine.createRecorder({ lossless: true })
    // Voice record sample shouldn't be longer than 5 seconds
    recorder.addEventListener(RecorderEvents.Started, (rec) => {
        timer = setTimeout(() => { recorder.stop() }, 3500)
        recordingURL = rec.url
    })
    recorder.addEventListener(RecorderEvents.Stopped, async () => {
        try {
            // See https://api.voiceit.io/?shell#create-voice-enrollment-by-url
            let res = await httpRequest('https://api.voiceit.io/enrollments/voice/byUrl', 'POST', 'application/json', {
                userId: userId,
                contentLanguage: contentLanguage,
                phrase: phrase,
                fileUrl: recordingURL
            })
            if (res.responseCode == 'SUCC') {
                enrollCount++
                // VoiceIt requires at least 3 successful enrollments
                if (enrollCount > 2) {
                    call.say('Thank you, recording recieved. You are now enrolle and can log in.', voice);
                    call.addEventListener(CallEvents.PlaybackFinished, authenticate)
                } else {
                    call.say('Thank you, recording recieved. Please say the phrase again.', voice);
                    call.addEventListener(CallEvents.PlaybackFinished, startEnrollment);
                }
            } else {
                call.say('Sorry, your recording did not stick. Please try again', voice);
                call.addEventListener(CallEvents.PlaybackFinished, startEnrollment);
            }
        } catch (err) {
            // Something went wrong
            Logger.write(err)
            call.say('Sorry, your recording did not stick. Please try again', voice);
            call.addEventListener(CallEvents.PlaybackFinished, startEnrollment)
        }
    })
    // Send call audio to the recorder
    call.sendMediaTo(recorder)
}

function authenticate() {
    call.removeEventListener(CallEvents.PlaybackFinished)
    let recordingURL, timer = null;
    // See the phrase var: my face and voice identify me	
    call.say(`<speak>Please say the following phrase to authenticate.<break time="1s"/> ${phrase}.</speak>`, voice)
    call.addEventListener(CallEvents.PlaybackFinished, (event) => {
        call.removeEventListener(CallEvents.PlaybackFinished)
        recorder = VoxEngine.createRecorder({ lossless: true })
        recorder.addEventListener(RecorderEvents.Started, (rec) => {
            timer = setTimeout(() => { recorder.stop() }, 3500)
            recordingURL = rec.url
        })
        recorder.addEventListener(RecorderEvents.Stopped, async () => {
            try {
                // See https://api.voiceit.io/?shell#verify-a-user-s-voice-by-url
                let res = await httpRequest('https://api.voiceit.io/verification/voice/byUrl', 'POST', 'application/json', {
                    userId: userId,
                    contentLanguage: contentLanguage,
                    phrase: phrase,
                    fileUrl: recordingURL
                })
                if (res.responseCode == 'SUCC') {
                    call.say(`The authentication is successful. Confidence level is ${res.confidence}%`, voice)
                    call.addEventListener(CallEvents.PlaybackFinished, VoxEngine.terminate)
                } else {
                    call.say('Your authentication did not pass. Please try again.', voice)
                    call.addEventListener(CallEvents.PlaybackFinished, authenticate)
                }
            } catch (err) {
                // Something went wrong
                Logger.write(err)
                call.say('Your authentication did not pass. Please try again.', voice)
                call.addEventListener(CallEvents.PlaybackFinished, authenticate)
            }
        })
        // Send call audio to the recorder
        call.sendMediaTo(recorder)
    })
}

function terminateGracefully() {
    call.say('We are sorry, but the service is temporarily unavailable. Please try again later.', voice)
    call.addEventListener(CallEvents.PlaybackFinished, VoxEngine.terminate)
}