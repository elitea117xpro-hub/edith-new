# E.D.I.T.H. delivery outcomes

## Account creation and profiles
- [x] People can create an account in E.D.I.T.H. with a unique username and password.
- [x] People can sign in, remain signed in through a secure session cookie, sign out, and see their own profile identity.

## Username-based connections
- [x] A signed-in person can search for another person by username.
- [x] A signed-in person can add another person using that username.
- [x] Contacts are persisted and shown in the contacts list with online/offline presence.

## Text communication
- [x] Contacts can open a one-to-one conversation.
- [x] Users can send text messages and retrieve persistent message history.
- [x] New messages are broadcast in real time over WebSocket connections and remain readable after refresh.

## Voice and video calls
- [x] A user can initiate a one-to-one voice call or video call from an open conversation.
- [x] The other user receives an incoming-call prompt and can accept or decline.
- [x] Active calls provide mute, camera toggle, and hang-up controls.
- [x] WebRTC signaling is handled by the Python server and media is peer-to-peer.

## Audio device controls
- [x] The call panel lists available microphones and lets the user choose the input device.
- [x] The call panel lists available speaker/output devices and applies the chosen sink when browser support is available.
- [x] The UI communicates the browser limitation when output-device switching is unavailable.

## Installable Android and Linux delivery
- [x] The app is installable as a PWA on Android and Linux through a compatible browser.
- [x] The supplied futuristic cyan circular HUD image is used for the app brand and install icons.
- [x] Source code, setup/build documentation, and release configuration are included in the GitHub repository named `E.D.I.T.H.`.

## Delivery status
- [x] Run the clean Python checks and verify Preview readiness.
- [x] Create/connect the GitHub repository named `E.D.I.T.H.` and push the complete app source.
